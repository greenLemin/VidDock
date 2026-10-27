import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBinary, probe, runFfmpeg, type ProbeResult } from '../src/ffmpeg.ts';
import { buildMuxArgs, chooseContainer, type ContainerChoice, type MuxInput } from '../src/mux.ts';
import { analyzeProbe } from '../src/verify.ts';
import { ensureFixtures } from '../../../tests/helpers/fixtures.ts';

function makeMockInput(opts: {
  file: string;
  kind?: 'video' | 'audio' | 'muxed';
  videoCodecs?: string[];
  audioCodecs?: string[];
}): MuxInput {
  const streams: ProbeResult['streams'] = [];
  let idx = 0;
  for (const vc of opts.videoCodecs ?? []) {
    streams.push({
      index: idx++,
      codec_type: 'video',
      codec_name: vc,
      width: 1280,
      height: 720,
    });
  }
  for (const ac of opts.audioCodecs ?? []) {
    streams.push({
      index: idx++,
      codec_type: 'audio',
      codec_name: ac,
    });
  }
  return {
    file: opts.file,
    kind: opts.kind ?? 'muxed',
    probe: {
      format: { duration: '60.0' },
      streams,
    },
  };
}

describe('chooseContainer', () => {
  it('chooses mp4 for single h264 video + aac audio under auto', () => {
    const inputs = [makeMockInput({ file: 'in.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] })];
    const choice = chooseContainer('auto', inputs);
    expect(choice.ext).toBe('mp4');
    expect(choice.format).toBe('mp4');
  });

  it('chooses mkv for multi-track video feeds when layout is unspecified or multi-track', () => {
    const inputs = [
      makeMockInput({ file: 'v1.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }),
      makeMockInput({ file: 'v2.mp4', videoCodecs: ['h264'] }),
    ];
    const autoChoice = chooseContainer('auto', inputs);
    expect(autoChoice.ext).toBe('mkv');

    const multiTrackChoice = chooseContainer('auto', inputs, 'multi-track');
    expect(multiTrackChoice.ext).toBe('mkv');
  });

  it('chooses mp4 for dual video feeds when layout is side-by-side or pip', () => {
    const inputs = [
      makeMockInput({ file: 'slides.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }),
      makeMockInput({ file: 'camera.mp4', videoCodecs: ['h264'] }),
    ];
    const sbsChoice = chooseContainer('auto', inputs, 'side-by-side');
    expect(sbsChoice.ext).toBe('mp4');
    expect(sbsChoice.format).toBe('mp4');

    const pipChoice = chooseContainer('auto', inputs, 'pip');
    expect(pipChoice.ext).toBe('mp4');
    expect(pipChoice.format).toBe('mp4');
  });

  it('respects explicit mp4 preference for composited dual stream', () => {
    const inputs = [
      makeMockInput({ file: 'slides.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }),
      makeMockInput({ file: 'camera.mp4', videoCodecs: ['h264'] }),
    ];
    const choice = chooseContainer('mp4', inputs, 'side-by-side');
    expect(choice.ext).toBe('mp4');
  });

  it('selects audio container for audio-only streams', () => {
    const singleAac = [makeMockInput({ file: 'a.aac', audioCodecs: ['aac'] })];
    expect(chooseContainer('auto', singleAac).ext).toBe('m4a');

    const singleOpus = [makeMockInput({ file: 'a.opus', audioCodecs: ['opus'] })];
    expect(chooseContainer('auto', singleOpus).ext).toBe('ogg');

    const multiAudio = [makeMockInput({ file: 'a.mka', audioCodecs: ['aac', 'opus'] })];
    expect(chooseContainer('auto', multiAudio).ext).toBe('mka');
  });
});

describe('buildMuxArgs', () => {
  it('uses stream copy for single video + audio input', () => {
    const inputs = [makeMockInput({ file: 'in.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] })];
    const choice = chooseContainer('auto', inputs);
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'out.mp4',
      title: 'Sample',
    });

    expect(args).toContain('-c');
    expect(args).toContain('copy');
    expect(args).not.toContain('-filter_complex');
    expect(args).toContain('out.mp4');
  });

  it('builds hstack filtergraph and libx264 encoding for side-by-side layout', () => {
    const inputs = [
      makeMockInput({ file: 'presentation.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }),
      makeMockInput({ file: 'camera.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }),
    ];
    const choice = chooseContainer('auto', inputs, 'side-by-side');
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'out.mp4',
      title: 'Side-by-side Lecture',
      layout: 'side-by-side',
    });

    expect(args).toContain('-filter_complex');
    const fcIndex = args.indexOf('-filter_complex');
    const filter = args[fcIndex + 1];
    expect(filter).toContain('hstack=inputs=2[v]');
    expect(filter).toContain('scale=960:540:force_original_aspect_ratio=decrease');
    expect(filter).toContain('pad=960:540:(ow-iw)/2:(oh-ih)/2');

    expect(args).toContain('-map');
    expect(args).toContain('[v]');
    // Primary audio mapped (index 0), secondary ignored
    expect(args).toContain('0:a');
    expect(args).not.toContain('1:a');

    expect(args).toContain('-c:v');
    expect(args).toContain('libx264');
    expect(args).toContain('-preset');
    expect(args).toContain('fast');
    expect(args).toContain('-crf');
    expect(args).toContain('22');
    expect(args).toContain('-pix_fmt');
    expect(args).toContain('yuv420p');
  });

  it('builds overlay filtergraph and libx264 encoding for pip layout', () => {
    const inputs = [
      makeMockInput({ file: 'presentation.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }),
      makeMockInput({ file: 'camera.mp4', videoCodecs: ['h264'] }),
    ];
    const choice = chooseContainer('auto', inputs, 'pip');
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'out.mp4',
      title: 'PiP Lecture',
      layout: 'pip',
    });

    expect(args).toContain('-filter_complex');
    const fcIndex = args.indexOf('-filter_complex');
    const filter = args[fcIndex + 1];
    expect(filter).toContain('overlay=W-w-24:H-h-24[v]');
    expect(filter).toContain('scale=iw/3.5:-2');

    expect(args).toContain('-map');
    expect(args).toContain('[v]');
    expect(args).toContain('0:a');

    expect(args).toContain('-c:v');
    expect(args).toContain('libx264');
  });

  it('falls back to copy when layout is multi-track', () => {
    const inputs = [
      makeMockInput({ file: 'v1.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }),
      makeMockInput({ file: 'v2.mp4', videoCodecs: ['h264'] }),
    ];
    const choice = chooseContainer('auto', inputs, 'multi-track');
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'out.mkv',
      title: 'Multi-track',
      layout: 'multi-track',
    });

    expect(args).not.toContain('-filter_complex');
    expect(args).toContain('-c');
    expect(args).toContain('copy');
  });

  it('falls back to copy if layout is side-by-side but input only has 1 video stream', () => {
    const inputs = [makeMockInput({ file: 'single.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] })];
    const choice = chooseContainer('auto', inputs, 'side-by-side');
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'out.mp4',
      title: 'Fallback',
      layout: 'side-by-side',
    });

    expect(args).not.toContain('-filter_complex');
    expect(args).toContain('-c');
    expect(args).toContain('copy');
  });

  it('builds overlay filtergraph with even-dimension scaling on base video for pip layout', () => {
    const inputs = [
      makeMockInput({ file: 'presentation_odd.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }),
      makeMockInput({ file: 'camera.mp4', videoCodecs: ['h264'] }),
    ];
    const choice = chooseContainer('auto', inputs, 'pip');
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'out.mp4',
      title: 'PiP Even Dimension Test',
      layout: 'pip',
    });

    expect(args).toContain('-filter_complex');
    const fcIndex = args.indexOf('-filter_complex');
    const filter = args[fcIndex + 1];
    expect(filter).toContain('scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[main]');
    expect(filter).toContain('scale=iw/3.5:-2,setsar=1[pip]');
    expect(filter).toContain('overlay=W-w-24:H-h-24[v]');
  });

  it('disambiguates video stream indices when a single input contains multiple video streams', () => {
    const multiVideoInput: MuxInput = {
      file: 'multi.mp4',
      kind: 'video',
      probe: {
        format: { duration: '10.0' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
          { index: 1, codec_type: 'video', codec_name: 'h264', width: 640, height: 480 },
        ],
      },
    };

    const choiceSbs = chooseContainer('auto', [multiVideoInput], 'side-by-side');
    const sbsArgs = buildMuxArgs({
      inputs: [multiVideoInput],
      subtitles: [],
      choice: choiceSbs,
      output: 'out.mp4',
      title: 'SbS Disambiguation',
      layout: 'side-by-side',
    });
    const sbsFilter = sbsArgs[sbsArgs.indexOf('-filter_complex') + 1]!;
    expect(sbsFilter).toContain('[0:v:0]');
    expect(sbsFilter).toContain('[0:v:1]');
    expect(sbsFilter).not.toMatch(/\[0:v\]/);

    const choicePip = chooseContainer('auto', [multiVideoInput], 'pip');
    const pipArgs = buildMuxArgs({
      inputs: [multiVideoInput],
      subtitles: [],
      choice: choicePip,
      output: 'out.mp4',
      title: 'PiP Disambiguation',
      layout: 'pip',
    });
    const pipFilter = pipArgs[pipArgs.indexOf('-filter_complex') + 1]!;
    expect(pipFilter).toContain('[0:v:0]');
    expect(pipFilter).toContain('[0:v:1]');
    expect(pipFilter).not.toMatch(/\[0:v\]/);
  });
});

describe('dual-stream live remuxing integration', () => {
  it('remuxes synthetic mediasite lecture feeds into valid side-by-side and pip MP4s with synced audio', async () => {
    const ffmpeg = findBinary('ffmpeg');
    const ffprobe = findBinary('ffprobe');
    if (!ffmpeg || !ffprobe) {
      // Skip if ffmpeg is unavailable in test environment
      return;
    }

    const fixtureDir = await ensureFixtures();
    const cameraPath = path.join(fixtureDir, 'mediasite', 'camera.mp4');
    const screenPath = path.join(fixtureDir, 'mediasite', 'screen.mp4');

    expect(fs.existsSync(cameraPath)).toBe(true);
    expect(fs.existsSync(screenPath)).toBe(true);

    const cameraProbe = await probe(ffprobe, cameraPath);
    const screenProbe = await probe(ffprobe, screenPath);

    const inputs: MuxInput[] = [
      { file: screenPath, kind: 'muxed', probe: screenProbe },
      { file: cameraPath, kind: 'muxed', probe: cameraProbe },
    ];

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-mux-test-'));

    try {
      // 1. Test side-by-side
      const sbsOutput = path.join(tmpDir, 'lecture-sbs.mp4');
      const sbsChoice = chooseContainer('auto', inputs, 'side-by-side');
      expect(sbsChoice.ext).toBe('mp4');

      const sbsArgs = buildMuxArgs({
        inputs,
        subtitles: [],
        choice: sbsChoice,
        output: sbsOutput,
        title: 'Side-by-Side Test',
        layout: 'side-by-side',
      });

      const sbsRun = await runFfmpeg(ffmpeg, sbsArgs, new AbortController().signal);
      expect(sbsRun.code).toBe(0);
      expect(fs.existsSync(sbsOutput)).toBe(true);

      const sbsResultProbe = await probe(ffprobe, sbsOutput);
      const sbsAnalysis = analyzeProbe(sbsResultProbe, { video: true, audio: true, durationSec: 6 });
      expect(sbsAnalysis.errors).toEqual([]);

      const sbsVideo = sbsResultProbe.streams.find((s) => s.codec_type === 'video');
      const sbsAudio = sbsResultProbe.streams.find((s) => s.codec_type === 'audio');
      expect(sbsVideo).toBeDefined();
      expect(sbsAudio).toBeDefined();
      expect(sbsVideo?.codec_name).toBe('h264');
      expect(sbsAudio?.codec_name).toBe('aac');

      // 2. Test Picture-in-Picture
      const pipOutput = path.join(tmpDir, 'lecture-pip.mp4');
      const pipChoice = chooseContainer('auto', inputs, 'pip');
      expect(pipChoice.ext).toBe('mp4');

      const pipArgs = buildMuxArgs({
        inputs,
        subtitles: [],
        choice: pipChoice,
        output: pipOutput,
        title: 'PiP Test',
        layout: 'pip',
      });

      const pipRun = await runFfmpeg(ffmpeg, pipArgs, new AbortController().signal);
      expect(pipRun.code).toBe(0);
      expect(fs.existsSync(pipOutput)).toBe(true);

      const pipResultProbe = await probe(ffprobe, pipOutput);
      const pipAnalysis = analyzeProbe(pipResultProbe, { video: true, audio: true, durationSec: 6 });
      expect(pipAnalysis.errors).toEqual([]);

      const pipVideo = pipResultProbe.streams.find((s) => s.codec_type === 'video');
      const pipAudio = pipResultProbe.streams.find((s) => s.codec_type === 'audio');
      expect(pipVideo).toBeDefined();
      expect(pipAudio).toBeDefined();
      expect(pipVideo?.codec_name).toBe('h264');
      expect(pipAudio?.codec_name).toBe('aac');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('remuxes odd-dimension feeds into a valid, playable PiP MP4 without libx264 encoder crash', async () => {
    const ffmpeg = findBinary('ffmpeg');
    const ffprobe = findBinary('ffprobe');
    if (!ffmpeg || !ffprobe) return;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-mux-odd-pip-'));
    try {
      const screenOdd = path.join(tmpDir, 'screen_853x480.mp4');
      const cameraEven = path.join(tmpDir, 'camera_640x480.mp4');

      // Create 853x480 (standard 480p 16:9 odd width)
      await runFfmpeg(
        ffmpeg,
        [
          '-f',
          'lavfi',
          '-i',
          'testsrc=duration=1:size=853x480:rate=25',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1:sample_rate=44100',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv444p',
          '-c:a',
          'aac',
          '-b:a',
          '64k',
          '-shortest',
          screenOdd,
        ],
        new AbortController().signal,
      );

      // Create 640x480
      await runFfmpeg(
        ffmpeg,
        [
          '-f',
          'lavfi',
          '-i',
          'testsrc=duration=1:size=640x480:rate=25',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          cameraEven,
        ],
        new AbortController().signal,
      );

      const screenProbe = await probe(ffprobe, screenOdd);
      const cameraProbe = await probe(ffprobe, cameraEven);

      const inputs: MuxInput[] = [
        { file: screenOdd, kind: 'muxed', probe: screenProbe },
        { file: cameraEven, kind: 'video', probe: cameraProbe },
      ];

      const pipOutput = path.join(tmpDir, 'pip-odd.mp4');
      const pipChoice = chooseContainer('auto', inputs, 'pip');
      const pipArgs = buildMuxArgs({
        inputs,
        subtitles: [],
        choice: pipChoice,
        output: pipOutput,
        title: 'PiP Odd Integration',
        layout: 'pip',
      });

      const pipRun = await runFfmpeg(ffmpeg, pipArgs, new AbortController().signal);
      expect(pipRun.code).toBe(0);
      expect(fs.existsSync(pipOutput)).toBe(true);

      const resultProbe = await probe(ffprobe, pipOutput);
      const analysis = analyzeProbe(resultProbe, { video: true, audio: true, durationSec: 1 });
      expect(analysis.errors).toEqual([]);

      const vid = resultProbe.streams.find((s) => s.codec_type === 'video');
      expect(vid?.width).toBe(852); // Truncated to even width
      expect(vid?.height).toBe(480);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('guarantees slides/screen is main canvas and presenter camera is overlay inset in PiP layout regardless of input order', () => {
    // Input 0 is camera, Input 1 is slides
    const inputs: MuxInput[] = [
      makeMockInput({ file: 'camera_presenter.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }),
      makeMockInput({ file: 'presentation_slides.mp4', videoCodecs: ['h264'] }),
    ];

    const choice = chooseContainer('auto', inputs, 'pip');
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'pip_swapped.mp4',
      title: 'PiP Canvas Test',
      layout: 'pip',
    });

    const fcIndex = args.indexOf('-filter_complex');
    const filter = args[fcIndex + 1]!;
    // Slides (input 1) must be scaled as [main], camera (input 0) must be scaled as [pip]
    expect(filter).toContain('[1:v:0]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[main]');
    expect(filter).toContain('[0:v:0]scale=iw/3.5:-2,setsar=1[pip]');
    expect(filter).toContain('[main][pip]overlay=W-w-24:H-h-24[v]');
  });

  it('maps and encodes decoupled audio stream when input container has standalone audio', () => {
    const inputs: MuxInput[] = [
      makeMockInput({ file: 'slides.mp4', videoCodecs: ['h264'] }),
      makeMockInput({ file: 'camera.mp4', videoCodecs: ['h264'] }),
      makeMockInput({ file: 'audio_mic.mp4', audioCodecs: ['aac'] }),
    ];

    const choice = chooseContainer('auto', inputs, 'side-by-side');
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'out_sbs_audio.mp4',
      title: 'Decoupled Audio SbS Test',
      layout: 'side-by-side',
    });

    expect(args).toContain('-map');
    expect(args).toContain('[v]');
    // Audio from input 2 should be mapped
    expect(args).toContain('2:a');
    expect(args).toContain('-c:a');
  });

  it('correctly orders slides and camera using track labels even when file paths are opaque stream.ts', () => {
    // Input 0 is Primary video (camera), Input 1 is Secondary video (slides)
    const inputs: MuxInput[] = [
      {
        ...makeMockInput({ file: '/tmp/work/t0/main/stream.ts', videoCodecs: ['h264'] }),
        label: 'Primary video',
      },
      {
        ...makeMockInput({ file: '/tmp/work/t1/main/stream.ts', videoCodecs: ['h264'] }),
        label: 'Secondary video (stream 2, type 1)',
      },
    ];

    const choice = chooseContainer('auto', inputs, 'pip');
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'pip_labeled.mp4',
      title: 'PiP Labeled Test',
      layout: 'pip',
    });

    const fcIndex = args.indexOf('-filter_complex');
    const filter = args[fcIndex + 1]!;
    // Input 1 (Secondary video / slides) must be [main], Input 0 (Primary video / camera) must be [pip]
    expect(filter).toContain('[1:v:0]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[main]');
    expect(filter).toContain('[0:v:0]scale=iw/3.5:-2,setsar=1[pip]');
    expect(filter).toContain('[main][pip]overlay=W-w-24:H-h-24[v]');
  });

  it('correctly selects slides feed as main canvas when presentation has 3 video streams in PiP', () => {
    const inputs: MuxInput[] = [
      {
        ...makeMockInput({ file: '/tmp/work/t0/main/stream.ts', videoCodecs: ['h264'] }),
        label: 'Primary video',
      },
      {
        ...makeMockInput({ file: '/tmp/work/t1/main/stream.ts', videoCodecs: ['h264'] }),
        label: 'Secondary video (stream 2, type 0)',
      },
      {
        ...makeMockInput({ file: '/tmp/work/t2/main/stream.ts', videoCodecs: ['h264'] }),
        label: 'Secondary video (stream 3, type 1)',
      },
    ];

    const choice = chooseContainer('auto', inputs, 'pip');
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'pip_3streams.mp4',
      title: 'PiP 3 Streams Test',
      layout: 'pip',
    });

    const fcIndex = args.indexOf('-filter_complex');
    const filter = args[fcIndex + 1]!;
    // Input 2 (Secondary video stream 3, type 1 / slides) must be [main]
    expect(filter).toContain('[2:v:0]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[main]');
  });

  it('transcodes video with libvpx-vp9 and audio with libopus when dual-stream choice is webm', () => {
    const inputs: MuxInput[] = [
      makeMockInput({ file: 'cam.mp4', videoCodecs: ['vp9'], audioCodecs: ['opus'] }),
      makeMockInput({ file: 'slides.mp4', videoCodecs: ['vp9'] }),
    ];

    const c: ContainerChoice = { ext: 'webm', format: 'webm' };
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice: c,
      output: 'dual.webm',
      title: 'WebM Dual Stream Test',
      layout: 'side-by-side',
    });

    expect(args).toContain('-c:v');
    expect(args).toContain('libvpx-vp9');
    expect(args).not.toContain('libx264');
    expect(args).toContain('-c:a');
  });

  it('correctly selects slides and camera feeds when presentation has 3 video streams in Side-by-Side layout', () => {
    const inputs: MuxInput[] = [
      {
        ...makeMockInput({ file: '/tmp/work/t0/main/stream.ts', videoCodecs: ['h264'] }),
        label: 'Primary video (Camera 1)',
      },
      {
        ...makeMockInput({ file: '/tmp/work/t1/main/stream.ts', videoCodecs: ['h264'] }),
        label: 'Secondary video (stream 2, type 0 - Camera 2)',
      },
      {
        ...makeMockInput({ file: '/tmp/work/t2/main/stream.ts', videoCodecs: ['h264'] }),
        label: 'Secondary video (stream 3, type 1 - Presentation Slides)',
      },
    ];

    const choice = chooseContainer('auto', inputs, 'side-by-side');
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'sbs_3streams.mp4',
      title: 'Side-by-Side 3 Streams Test',
      layout: 'side-by-side',
    });

    const fcIndex = args.indexOf('-filter_complex');
    const filter = args[fcIndex + 1]!;
    // Input 2 (Slides) must be included in the filter, not omitted!
    expect(filter).toContain('[2:v:0]');
    expect(filter).toContain('hstack=inputs=2[v]');
  });
});
