import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { findBinary, probe, runFfmpeg, type ProbeResult } from '../../packages/native-host/src/ffmpeg.ts';
import { buildMuxArgs, chooseContainer, type MuxInput } from '../../packages/native-host/src/mux.ts';
import { analyzeProbe } from '../../packages/native-host/src/verify.ts';

const execFileP = promisify(execFile);

function makeMockInput(opts: {
  file: string;
  kind?: 'video' | 'audio' | 'muxed';
  videoCodecs?: string[];
  audioCodecs?: string[];
  width?: number;
  height?: number;
}): MuxInput {
  const streams: ProbeResult['streams'] = [];
  let idx = 0;
  for (const vc of opts.videoCodecs ?? []) {
    streams.push({
      index: idx++,
      codec_type: 'video',
      codec_name: vc,
      width: opts.width ?? 1280,
      height: opts.height ?? 720,
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
      format: { duration: '10.0' },
      streams,
    },
  };
}

describe('M1 Stress Tests: chooseContainer Matrix', () => {
  const dualH264Aac = [
    makeMockInput({ file: 'screen.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }),
    makeMockInput({ file: 'camera.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }),
  ];

  it('evaluates chooseContainer for side-by-side across all container preferences', () => {
    expect(chooseContainer('auto', dualH264Aac, 'side-by-side').ext).toBe('mp4');
    expect(chooseContainer('mp4', dualH264Aac, 'side-by-side').ext).toBe('mp4');
    expect(chooseContainer('mkv', dualH264Aac, 'side-by-side').ext).toBe('mkv');
    // For WebM preference with H264 composite, it falls back to MKV because H264 is not webm
    expect(chooseContainer('webm', dualH264Aac, 'side-by-side').ext).toBe('mkv');
  });

  it('evaluates chooseContainer for pip across all container preferences', () => {
    expect(chooseContainer('auto', dualH264Aac, 'pip').ext).toBe('mp4');
    expect(chooseContainer('mp4', dualH264Aac, 'pip').ext).toBe('mp4');
    expect(chooseContainer('mkv', dualH264Aac, 'pip').ext).toBe('mkv');
    expect(chooseContainer('webm', dualH264Aac, 'pip').ext).toBe('mkv');
  });

  it('evaluates chooseContainer for multi-track across all container preferences', () => {
    // Under auto, multi-track with >1 video stream selects MKV
    expect(chooseContainer('auto', dualH264Aac, 'multi-track').ext).toBe('mkv');
    // Under explicit mp4, multiple H264 feeds are allowed in MP4 container
    expect(chooseContainer('mp4', dualH264Aac, 'multi-track').ext).toBe('mp4');
    expect(chooseContainer('mkv', dualH264Aac, 'multi-track').ext).toBe('mkv');
    expect(chooseContainer('webm', dualH264Aac, 'multi-track').ext).toBe('mkv');
  });

  it('evaluates chooseContainer for separate layout across preferences', () => {
    // Separate layout is not composite, so auto selects MKV for multiple video streams
    expect(chooseContainer('auto', dualH264Aac, 'separate').ext).toBe('mkv');
    expect(chooseContainer('mp4', dualH264Aac, 'separate').ext).toBe('mp4');
  });

  it('handles non-mp4 audio codecs under side-by-side layout', () => {
    const dualWithOpus = [
      makeMockInput({ file: 'screen.mp4', videoCodecs: ['h264'], audioCodecs: ['opus'] }),
      makeMockInput({ file: 'camera.mp4', videoCodecs: ['h264'] }),
    ];
    // Opus is allowed in MP4 container in MP4_AUDIO
    expect(chooseContainer('auto', dualWithOpus, 'side-by-side').ext).toBe('mp4');

    const dualWithVorbis = [
      makeMockInput({ file: 'screen.mp4', videoCodecs: ['h264'], audioCodecs: ['vorbis'] }),
      makeMockInput({ file: 'camera.mp4', videoCodecs: ['h264'] }),
    ];
    // Vorbis is not in MP4_AUDIO, so auto selects MKV
    expect(chooseContainer('auto', dualWithVorbis, 'side-by-side').ext).toBe('mkv');
  });
});

describe('M1 Stress Tests: buildMuxArgs audio variations', () => {
  it('handles primary audio when input 0 has audio and input 1 has audio', () => {
    const inputs = [
      makeMockInput({ file: 'in0.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }),
      makeMockInput({ file: 'in1.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }),
    ];
    const choice = chooseContainer('auto', inputs, 'side-by-side');
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'out.mp4',
      title: 'Test',
      layout: 'side-by-side',
    });
    // Only 0:a is mapped to avoid echo
    expect(args).toContain('0:a');
    expect(args).not.toContain('1:a');
  });

  it('handles audio when input 0 has NO audio but input 1 HAS audio', () => {
    const inputs = [
      makeMockInput({ file: 'screen.mp4', videoCodecs: ['h264'] }), // silent slides
      makeMockInput({ file: 'camera.mp4', videoCodecs: ['h264'], audioCodecs: ['aac'] }), // camera + mic
    ];
    const choice = chooseContainer('auto', inputs, 'side-by-side');
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'out.mp4',
      title: 'Test',
      layout: 'side-by-side',
    });
    // Maps 1:a because it is the only audio stream
    expect(args).toContain('1:a');
  });

  it('handles case where NEITHER stream has audio', () => {
    const inputs = [
      makeMockInput({ file: 'screen.mp4', videoCodecs: ['h264'] }),
      makeMockInput({ file: 'camera.mp4', videoCodecs: ['h264'] }),
    ];
    const choice = chooseContainer('auto', inputs, 'side-by-side');
    const args = buildMuxArgs({
      inputs,
      subtitles: [],
      choice,
      output: 'out.mp4',
      title: 'Test',
      layout: 'side-by-side',
    });
    // No audio stream mapped, no audio codec flag
    expect(args).not.toContain('-c:a');
    expect(args).toContain('-map');
    expect(args).toContain('[v]');
  });
});

describe('M1 Stress Tests: Live FFmpeg Edge Cases', () => {
  const ffmpeg = findBinary('ffmpeg');
  const ffprobe = findBinary('ffprobe');

  it('stress-tests mismatched aspect ratios (16:9 presentation + 4:3 camera)', async () => {
    if (!ffmpeg || !ffprobe) return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-stress-ar-'));
    try {
      const screenPath = path.join(tmpDir, 'screen_16_9.mp4');
      const cameraPath = path.join(tmpDir, 'camera_4_3.mp4');

      // 16:9 presentation (1280x720) with 440Hz audio
      await execFileP(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=1280x720:rate=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1:sample_rate=44100',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-shortest',
        screenPath,
      ]);

      // 4:3 camera (640x480) with 880Hz audio
      await execFileP(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=640x480:rate=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:duration=1:sample_rate=44100',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-shortest',
        cameraPath,
      ]);

      const screenProbe = await probe(ffprobe, screenPath);
      const cameraProbe = await probe(ffprobe, cameraPath);

      const inputs: MuxInput[] = [
        { file: screenPath, kind: 'muxed', probe: screenProbe },
        { file: cameraPath, kind: 'muxed', probe: cameraProbe },
      ];

      // Side-by-side with mismatched aspect ratios
      const sbsOut = path.join(tmpDir, 'sbs_mismatched.mp4');
      const sbsChoice = chooseContainer('auto', inputs, 'side-by-side');
      const sbsArgs = buildMuxArgs({
        inputs,
        subtitles: [],
        choice: sbsChoice,
        output: sbsOut,
        title: 'Mismatched AR SbS',
        layout: 'side-by-side',
      });
      const sbsRun = await runFfmpeg(ffmpeg, sbsArgs, new AbortController().signal);
      expect(sbsRun.code).toBe(0);

      const sbsProbe = await probe(ffprobe, sbsOut);
      const sbsVerify = analyzeProbe(sbsProbe, { video: true, audio: true, durationSec: 1 });
      expect(sbsVerify.errors).toEqual([]);
      const sbsVideo = sbsProbe.streams.find((s) => s.codec_type === 'video');
      expect(sbsVideo?.width).toBe(1920);
      expect(sbsVideo?.height).toBe(540);

      // PiP with mismatched aspect ratios
      const pipOut = path.join(tmpDir, 'pip_mismatched.mp4');
      const pipChoice = chooseContainer('auto', inputs, 'pip');
      const pipArgs = buildMuxArgs({
        inputs,
        subtitles: [],
        choice: pipChoice,
        output: pipOut,
        title: 'Mismatched AR PiP',
        layout: 'pip',
      });
      const pipRun = await runFfmpeg(ffmpeg, pipArgs, new AbortController().signal);
      expect(pipRun.code).toBe(0);

      const pipProbe = await probe(ffprobe, pipOut);
      const pipVerify = analyzeProbe(pipProbe, { video: true, audio: true, durationSec: 1 });
      expect(pipVerify.errors).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('stress-tests odd video dimensions: verifies odd base width (853x480) encodes cleanly in PiP', async () => {
    if (!ffmpeg || !ffprobe) return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-stress-odd-'));
    try {
      // 853x480 is standard 480p 16:9 on web video, but 853 is ODD
      const oddScreenPath = path.join(tmpDir, 'screen_853x480.mp4');
      const cameraPath = path.join(tmpDir, 'camera_640x480.mp4');

      // Generate 853x480 video with yuv444p (valid MP4 stream with odd width)
      await execFileP(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=853x480:rate=25',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv444p',
        oddScreenPath,
      ]);
      await execFileP(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
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
        cameraPath,
      ]);

      const screenProbe = await probe(ffprobe, oddScreenPath);
      const cameraProbe = await probe(ffprobe, cameraPath);

      const inputs: MuxInput[] = [
        { file: oddScreenPath, kind: 'video', probe: screenProbe },
        { file: cameraPath, kind: 'video', probe: cameraProbe },
      ];

      // Side-by-side handles odd dimensions by forcing scale to 960:540 and pad
      const sbsOut = path.join(tmpDir, 'sbs_odd.mp4');
      const sbsChoice = chooseContainer('auto', inputs, 'side-by-side');
      const sbsArgs = buildMuxArgs({
        inputs,
        subtitles: [],
        choice: sbsChoice,
        output: sbsOut,
        title: 'SbS Odd',
        layout: 'side-by-side',
      });
      const sbsRun = await runFfmpeg(ffmpeg, sbsArgs, new AbortController().signal);
      expect(sbsRun.code).toBe(0);

      // PiP with odd base video: test empirical behavior
      const pipOut = path.join(tmpDir, 'pip_odd.mp4');
      const pipChoice = chooseContainer('auto', inputs, 'pip');
      const pipArgs = buildMuxArgs({
        inputs,
        subtitles: [],
        choice: pipChoice,
        output: pipOut,
        title: 'PiP Odd',
        layout: 'pip',
      });
      const pipRun = await runFfmpeg(ffmpeg, pipArgs, new AbortController().signal);
      expect(pipRun.code).toBe(0);
      expect(fs.existsSync(pipOut)).toBe(true);

      const pipProbe = await probe(ffprobe, pipOut);
      const pipVerify = analyzeProbe(pipProbe, { video: true, audio: false, durationSec: 1 });
      expect(pipVerify.errors).toEqual([]);

      const vid = pipProbe.streams.find((s) => s.codec_type === 'video');
      expect(vid).toBeDefined();
      expect((vid?.width ?? 1) % 2).toBe(0);
      expect((vid?.height ?? 1) % 2).toBe(0);
      expect(vid?.width).toBe(852);
      expect(vid?.height).toBe(480);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('stress-tests odd video dimensions: verifies odd base width and height (641x361) encodes cleanly in PiP', async () => {
    if (!ffmpeg || !ffprobe) return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-stress-odd-wh-'));
    try {
      const oddScreenPath = path.join(tmpDir, 'screen_641x361.mp4');
      const cameraPath = path.join(tmpDir, 'camera_640x480.mp4');

      await execFileP(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=641x361:rate=25',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv444p',
        oddScreenPath,
      ]);
      await execFileP(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
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
        cameraPath,
      ]);

      const screenProbe = await probe(ffprobe, oddScreenPath);
      const cameraProbe = await probe(ffprobe, cameraPath);

      const inputs: MuxInput[] = [
        { file: oddScreenPath, kind: 'video', probe: screenProbe },
        { file: cameraPath, kind: 'video', probe: cameraProbe },
      ];

      const pipOut = path.join(tmpDir, 'pip_641x361.mp4');
      const pipChoice = chooseContainer('auto', inputs, 'pip');
      const pipArgs = buildMuxArgs({
        inputs,
        subtitles: [],
        choice: pipChoice,
        output: pipOut,
        title: 'PiP Odd WxH',
        layout: 'pip',
      });
      const pipRun = await runFfmpeg(ffmpeg, pipArgs, new AbortController().signal);
      expect(pipRun.code).toBe(0);
      expect(fs.existsSync(pipOut)).toBe(true);

      const pipProbe = await probe(ffprobe, pipOut);
      const pipVerify = analyzeProbe(pipProbe, { video: true, audio: false, durationSec: 1 });
      expect(pipVerify.errors).toEqual([]);

      const vid = pipProbe.streams.find((s) => s.codec_type === 'video');
      expect(vid?.width).toBe(640);
      expect(vid?.height).toBe(360);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('stress-tests unusual Sample Aspect Ratio (SAR != 1)', async () => {
    if (!ffmpeg || !ffprobe) return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-stress-sar-'));
    try {
      const anamorphicPath = path.join(tmpDir, 'anamorphic.mp4');
      const normalPath = path.join(tmpDir, 'normal.mp4');

      // 720x480 with SAR 4:3 (DAR 2:1)
      await execFileP(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=720x480:rate=25,setsar=4/3',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        anamorphicPath,
      ]);
      await execFileP(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=1280x720:rate=25',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        normalPath,
      ]);

      const anamorphicProbe = await probe(ffprobe, anamorphicPath);
      const normalProbe = await probe(ffprobe, normalPath);

      const inputs: MuxInput[] = [
        { file: anamorphicProbe.streams[0] ? anamorphicPath : '', kind: 'video', probe: anamorphicProbe },
        { file: normalPath, kind: 'video', probe: normalProbe },
      ];

      const sbsOut = path.join(tmpDir, 'sbs_sar.mp4');
      const sbsChoice = chooseContainer('auto', inputs, 'side-by-side');
      const sbsArgs = buildMuxArgs({
        inputs,
        subtitles: [],
        choice: sbsChoice,
        output: sbsOut,
        title: 'SAR Test',
        layout: 'side-by-side',
      });
      const sbsRun = await runFfmpeg(ffmpeg, sbsArgs, new AbortController().signal);
      expect(sbsRun.code).toBe(0);

      // Verify that output is SAR 1:1
      const resultProbe = await probe(ffprobe, sbsOut);
      const vid = resultProbe.streams.find((s) => s.codec_type === 'video');
      expect((vid as unknown as { sample_aspect_ratio?: string })?.sample_aspect_ratio).toBe('1:1');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('M1 Stress Tests: install-macos.sh boundary handling', () => {
  const scriptPath = path.resolve(import.meta.dirname, '../../scripts/install-macos.sh');

  it('fails with unbound variable when --extension-id flag is given without argument', async () => {
    try {
      await execFileP('bash', [scriptPath, '--extension-id']);
      expect.unreachable('Should have failed');
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string };
      expect(e.code).not.toBe(0);
      expect(e.stderr).toContain('unbound variable');
    }
  });

  it('fails with unbound variable when --launcher flag is given without argument', async () => {
    try {
      await execFileP('bash', [scriptPath, '--launcher']);
      expect.unreachable('Should have failed');
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string };
      expect(e.code).not.toBe(0);
      expect(e.stderr).toContain('unbound variable');
    }
  });

  it('exits with error when specified --launcher path does not exist', async () => {
    try {
      await execFileP('bash', [scriptPath, '--launcher', '/path/to/nonexistent/launcher.sh']);
      expect.unreachable('Should have failed');
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string };
      expect(e.code).toBe(1);
      expect(e.stderr).toContain('Specified launcher not found');
    }
  });

  it('validates --dry-run does not write manifest files to disk', async () => {
    const res = await execFileP('bash', [scriptPath, '--dry-run']);
    expect(res.stdout).toContain('[DRY-RUN]');
    expect(res.stdout).toContain('Dry-run complete. No files were modified.');
  });

  it('rejects origin injection payload with exit code 1', async () => {
    const injectionId = 'malicious", "chrome-extension://attacker/';
    try {
      await execFileP('bash', [scriptPath, '--dry-run', injectionId]);
      expect.unreachable('Should have rejected injection payload');
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string };
      expect(e.code).toBe(1);
      expect(e.stderr).toContain('Error: Extension ID');
      expect(e.stderr).toContain('is invalid');
    }
  });

  it('rejects invalid characters in extension ID with exit code 1 and creates zero manifest files', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-fakehome-'));
    try {
      const corruptId = 'malicious"injection';
      const chromeHostDir = path.join(fakeHome, 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
      fs.mkdirSync(chromeHostDir, { recursive: true });

      try {
        await execFileP('bash', [scriptPath, corruptId], {
          env: { ...process.env, HOME: fakeHome },
        });
        expect.unreachable('Should have rejected corrupt ID');
      } catch (err: unknown) {
        const e = err as { code?: number; stderr?: string };
        expect(e.code).toBe(1);
        expect(e.stderr).toContain('Error: Extension ID');
        expect(e.stderr).toContain('is invalid');
      }

      const manifestPath = path.join(chromeHostDir, 'com.viddock.host.json');
      expect(fs.existsSync(manifestPath)).toBe(false);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('rejects extension IDs not matching exactly 32 lowercase [a-p] characters', async () => {
    const invalidIds = [
      'tooshort',
      'abcdefghijklmnopqrstuvwxyz123456', // letters q-z and digits
      'PKNLJCHBLNKGFMFCFDFKDDEDJOFMJBKJ', // uppercase
      'pknljchblnkgfmfcfdfkddedjofmjbkjextra', // > 32 characters
      'pknljchblnkgfmfcfdfkddedjofmjbk;', // shell delimiter
      'pknljchblnkgfmfcfdfkddedjofmjbk ', // trailing space
    ];

    for (const badId of invalidIds) {
      try {
        await execFileP('bash', [scriptPath, '--dry-run', badId]);
        expect.unreachable(`Should have rejected '${badId}'`);
      } catch (err: unknown) {
        const e = err as { code?: number; stderr?: string };
        expect(e.code).toBe(1);
        expect(e.stderr).toContain('Error: Extension ID');
      }
    }
  });

  it('accepts valid 32-char [a-p] extension ID via flag and positional arg and writes valid JSON', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-fakehome-valid-'));
    try {
      const validId = 'pknljchblnkgfmfcfdfkddedjofmjbkj';
      const chromeHostDir = path.join(fakeHome, 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
      fs.mkdirSync(chromeHostDir, { recursive: true });

      // Test positional argument
      const res = await execFileP('bash', [scriptPath, validId], {
        env: { ...process.env, HOME: fakeHome },
      });
      expect(res.stdout).toContain(`Using specified Extension ID: ${validId}`);

      const manifestPath = path.join(chromeHostDir, 'com.viddock.host.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const content = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.name).toBe('com.viddock.host');
      expect(parsed.allowed_origins).toEqual([`chrome-extension://${validId}/`]);

      // Test --extension-id flag with dry-run
      const flagRes = await execFileP('bash', [scriptPath, '--dry-run', '--extension-id', validId]);
      expect(flagRes.stdout).toContain(`Using specified Extension ID: ${validId}`);
      expect(flagRes.stdout).toContain('[DRY-RUN]');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('M1 Stress Tests: Multi-stream edge cases in single input', () => {
  it('disambiguates stream indices when a single input has two video streams', () => {
    const singleInputWithTwoVideos: MuxInput = {
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
    const choice = chooseContainer('auto', [singleInputWithTwoVideos], 'side-by-side');
    const args = buildMuxArgs({
      inputs: [singleInputWithTwoVideos],
      subtitles: [],
      choice,
      output: 'out.mp4',
      title: 'Dual stream in single file',
      layout: 'side-by-side',
    });
    const filterArg = args[args.indexOf('-filter_complex') + 1]!;
    // Both [left] and [right] reference disambiguated stream indices [0:v:0] and [0:v:1]
    expect(filterArg).toContain('[0:v:0]');
    expect(filterArg).toContain('[0:v:1]');
    expect(filterArg).not.toMatch(/\[0:v\]/);
  });

  it('disambiguates stream indices in PiP layout when a single input has two video streams', () => {
    const singleInputWithTwoVideos: MuxInput = {
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
    const choice = chooseContainer('auto', [singleInputWithTwoVideos], 'pip');
    const args = buildMuxArgs({
      inputs: [singleInputWithTwoVideos],
      subtitles: [],
      choice,
      output: 'out.mp4',
      title: 'Dual stream in single file PiP',
      layout: 'pip',
    });
    const filterArg = args[args.indexOf('-filter_complex') + 1]!;
    expect(filterArg).toContain('[0:v:1]'); // Inset
    expect(filterArg).toContain('[0:v:0]'); // Main canvas
    expect(filterArg).not.toMatch(/\[0:v\]/);
  });

  it('embeds subtitles into side-by-side MP4 without error', async () => {
    const ffmpegBin = findBinary('ffmpeg');
    const ffprobeBin = findBinary('ffprobe');
    if (!ffmpegBin || !ffprobeBin) return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-stress-subs-'));
    try {
      const v0Path = path.join(tmpDir, 'v0.mp4');
      const v1Path = path.join(tmpDir, 'v1.mp4');
      const srtPath = path.join(tmpDir, 'subs.srt');

      await execFileP(ffmpegBin, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
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
        v0Path,
      ]);
      await execFileP(ffmpegBin, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
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
        v1Path,
      ]);
      fs.writeFileSync(srtPath, `1\n00:00:00,000 --> 00:00:01,000\nHello lecture\n\n`);

      const v0Probe = await probe(ffprobeBin, v0Path);
      const v1Probe = await probe(ffprobeBin, v1Path);

      const inputs: MuxInput[] = [
        { file: v0Path, kind: 'video', probe: v0Probe },
        { file: v1Path, kind: 'video', probe: v1Probe },
      ];

      const sbsOut = path.join(tmpDir, 'sbs_subs.mp4');
      const choice = chooseContainer('auto', inputs, 'side-by-side');
      const args = buildMuxArgs({
        inputs,
        subtitles: [{ file: srtPath, language: 'eng', label: 'English' }],
        choice,
        output: sbsOut,
        title: 'SbS Subs',
        layout: 'side-by-side',
      });
      const run = await runFfmpeg(ffmpegBin, args, new AbortController().signal);
      expect(run.code).toBe(0);
      const resProbe = await probe(ffprobeBin, sbsOut);
      const subStream = resProbe.streams.find((s) => s.codec_type === 'subtitle');
      expect(subStream).toBeDefined();
      expect(subStream?.codec_name).toBe('mov_text');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
