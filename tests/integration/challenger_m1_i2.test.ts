import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { findBinary, probe, runFfmpeg } from '../../packages/native-host/src/ffmpeg.ts';
import { buildMuxArgs, chooseContainer, type MuxInput } from '../../packages/native-host/src/mux.ts';
import { analyzeProbe } from '../../packages/native-host/src/verify.ts';

const execFileP = promisify(execFile);

describe('Challenger M1 I2: Empirical Stress Harness', () => {
  const ffmpeg = findBinary('ffmpeg');
  const ffprobe = findBinary('ffprobe');

  async function createSyntheticVideo(
    dir: string,
    filename: string,
    width: number,
    height: number,
    opts: { audio?: boolean; duration?: number } = {},
  ): Promise<string> {
    if (!ffmpeg) throw new Error('ffmpeg binary not found');
    const filePath = path.join(dir, filename);
    const duration = opts.duration ?? 1;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${duration}:size=${width}x${height}:rate=25`,
    ];
    if (opts.audio) {
      args.push(
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${duration}:sample_rate=44100`,
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
      );
    } else {
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv444p');
    }
    args.push(filePath);
    await execFileP(ffmpeg, args);
    return filePath;
  }

  describe('1. Odd Dimensions in PiP and Side-by-Side Layouts', () => {
    it('empirically verifies primary with odd width and odd height (853x481, 1023x767, 333x333) in PiP', async () => {
      if (!ffmpeg || !ffprobe) return;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-odd-pri-'));
      try {
        const oddSizes = [
          { w: 853, h: 481, expW: 852, expH: 480 },
          { w: 1023, h: 767, expW: 1022, expH: 766 },
          { w: 333, h: 333, expW: 332, expH: 332 },
        ];

        const secPath = await createSyntheticVideo(tmpDir, 'sec_640x480.mp4', 640, 480, { audio: false });
        const secProbe = await probe(ffprobe, secPath);

        for (const sz of oddSizes) {
          const priPath = await createSyntheticVideo(tmpDir, `pri_${sz.w}x${sz.h}.mp4`, sz.w, sz.h, { audio: true });
          const priProbe = await probe(ffprobe, priPath);

          const inputs: MuxInput[] = [
            { file: priPath, kind: 'muxed', probe: priProbe },
            { file: secPath, kind: 'video', probe: secProbe },
          ];

          const outPath = path.join(tmpDir, `out_pip_${sz.w}x${sz.h}.mp4`);
          const choice = chooseContainer('auto', inputs, 'pip');
          const args = buildMuxArgs({
            inputs,
            subtitles: [],
            choice,
            output: outPath,
            title: `PiP ${sz.w}x${sz.h}`,
            layout: 'pip',
          });

          const res = await runFfmpeg(ffmpeg, args, new AbortController().signal);
          expect(res.code).toBe(0);
          expect(fs.existsSync(outPath)).toBe(true);

          const outProbe = await probe(ffprobe, outPath);
          const v = outProbe.streams.find((s) => s.codec_type === 'video');
          expect(v?.width).toBe(sz.expW);
          expect(v?.height).toBe(sz.expH);
          expect((v?.width ?? 1) % 2).toBe(0);
          expect((v?.height ?? 1) % 2).toBe(0);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('empirically verifies PiP overlay with odd width and odd height (321x241, 199x199) onto even primary', async () => {
      if (!ffmpeg || !ffprobe) return;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-odd-pip-'));
      try {
        const priPath = await createSyntheticVideo(tmpDir, 'pri_1280x720.mp4', 1280, 720, { audio: true });
        const priProbe = await probe(ffprobe, priPath);

        const overlaySizes = [
          { w: 321, h: 241 },
          { w: 199, h: 199 },
        ];

        for (const sz of overlaySizes) {
          const pipPath = await createSyntheticVideo(tmpDir, `pip_${sz.w}x${sz.h}.mp4`, sz.w, sz.h, { audio: false });
          const pipProbe = await probe(ffprobe, pipPath);

          const inputs: MuxInput[] = [
            { file: priPath, kind: 'muxed', probe: priProbe },
            { file: pipPath, kind: 'video', probe: pipProbe },
          ];

          const outPath = path.join(tmpDir, `out_pip_sec_${sz.w}x${sz.h}.mp4`);
          const choice = chooseContainer('auto', inputs, 'pip');
          const args = buildMuxArgs({
            inputs,
            subtitles: [],
            choice,
            output: outPath,
            title: `PiP Overlay ${sz.w}x${sz.h}`,
            layout: 'pip',
          });

          const res = await runFfmpeg(ffmpeg, args, new AbortController().signal);
          expect(res.code).toBe(0);
          expect(fs.existsSync(outPath)).toBe(true);

          const outProbe = await probe(ffprobe, outPath);
          const v = outProbe.streams.find((s) => s.codec_type === 'video');
          expect(v?.width).toBe(1280);
          expect(v?.height).toBe(720);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('empirically verifies odd width and odd height on BOTH feeds simultaneously (853x481 + 321x241, 333x333 + 199x199)', async () => {
      if (!ffmpeg || !ffprobe) return;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-odd-both-'));
      try {
        const pairs = [
          { pri: { w: 853, h: 481, expW: 852, expH: 480 }, sec: { w: 321, h: 241 } },
          { pri: { w: 333, h: 333, expW: 332, expH: 332 }, sec: { w: 199, h: 199 } },
        ];

        for (const pair of pairs) {
          const priPath = await createSyntheticVideo(
            tmpDir,
            `pri_${pair.pri.w}x${pair.pri.h}.mp4`,
            pair.pri.w,
            pair.pri.h,
            { audio: true },
          );
          const secPath = await createSyntheticVideo(
            tmpDir,
            `sec_${pair.sec.w}x${pair.sec.h}.mp4`,
            pair.sec.w,
            pair.sec.h,
            { audio: false },
          );

          const priProbe = await probe(ffprobe, priPath);
          const secProbe = await probe(ffprobe, secPath);

          const inputs: MuxInput[] = [
            { file: priPath, kind: 'muxed', probe: priProbe },
            { file: secPath, kind: 'video', probe: secProbe },
          ];

          // PiP
          const pipOut = path.join(tmpDir, `pip_${pair.pri.w}_${pair.sec.w}.mp4`);
          const pipArgs = buildMuxArgs({
            inputs,
            subtitles: [],
            choice: chooseContainer('auto', inputs, 'pip'),
            output: pipOut,
            title: 'PiP Odd Both',
            layout: 'pip',
          });
          const pipRes = await runFfmpeg(ffmpeg, pipArgs, new AbortController().signal);
          expect(pipRes.code).toBe(0);

          const pipProbe = await probe(ffprobe, pipOut);
          const pipV = pipProbe.streams.find((s) => s.codec_type === 'video');
          expect(pipV?.width).toBe(pair.pri.expW);
          expect(pipV?.height).toBe(pair.pri.expH);

          // Side-by-Side
          const sbsOut = path.join(tmpDir, `sbs_${pair.pri.w}_${pair.sec.w}.mp4`);
          const sbsArgs = buildMuxArgs({
            inputs,
            subtitles: [],
            choice: chooseContainer('auto', inputs, 'side-by-side'),
            output: sbsOut,
            title: 'SbS Odd Both',
            layout: 'side-by-side',
          });
          const sbsRes = await runFfmpeg(ffmpeg, sbsArgs, new AbortController().signal);
          expect(sbsRes.code).toBe(0);

          const sbsProbe = await probe(ffprobe, sbsOut);
          const sbsV = sbsProbe.streams.find((s) => s.codec_type === 'video');
          expect(sbsV?.width).toBe(1920);
          expect(sbsV?.height).toBe(540);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('2. Inverted and Extreme Aspect Ratios', () => {
    it('empirically verifies portrait primary (1080x1920) with landscape secondary (1280x720) in PiP and SbS', async () => {
      if (!ffmpeg || !ffprobe) return;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-inv-port-pri-'));
      try {
        const portraitPath = await createSyntheticVideo(tmpDir, 'portrait.mp4', 1080, 1920, { audio: true });
        const landscapePath = await createSyntheticVideo(tmpDir, 'landscape.mp4', 1280, 720, { audio: false });

        const pPort = await probe(ffprobe, portraitPath);
        const pLand = await probe(ffprobe, landscapePath);

        const inputs: MuxInput[] = [
          { file: portraitPath, kind: 'muxed', probe: pPort },
          { file: landscapePath, kind: 'video', probe: pLand },
        ];

        // PiP: Portrait canvas with landscape inset
        const pipOut = path.join(tmpDir, 'pip_portrait_canvas.mp4');
        const pipArgs = buildMuxArgs({
          inputs,
          subtitles: [],
          choice: chooseContainer('auto', inputs, 'pip'),
          output: pipOut,
          title: 'Portrait Canvas PiP',
          layout: 'pip',
        });
        const pipRes = await runFfmpeg(ffmpeg, pipArgs, new AbortController().signal);
        expect(pipRes.code).toBe(0);

        const pipProbe = await probe(ffprobe, pipOut);
        const pipV = pipProbe.streams.find((s) => s.codec_type === 'video');
        expect(pipV?.width).toBe(1080);
        expect(pipV?.height).toBe(1920);

        // Side-by-Side: Portrait + Landscape side-by-side
        const sbsOut = path.join(tmpDir, 'sbs_portrait_landscape.mp4');
        const sbsArgs = buildMuxArgs({
          inputs,
          subtitles: [],
          choice: chooseContainer('auto', inputs, 'side-by-side'),
          output: sbsOut,
          title: 'Portrait Landscape SbS',
          layout: 'side-by-side',
        });
        const sbsRes = await runFfmpeg(ffmpeg, sbsArgs, new AbortController().signal);
        expect(sbsRes.code).toBe(0);

        const sbsProbe = await probe(ffprobe, sbsOut);
        const sbsV = sbsProbe.streams.find((s) => s.codec_type === 'video');
        expect(sbsV?.width).toBe(1920);
        expect(sbsV?.height).toBe(540);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('empirically verifies landscape primary (1920x1080) with portrait secondary (1080x1920) in PiP and SbS', async () => {
      if (!ffmpeg || !ffprobe) return;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-inv-port-sec-'));
      try {
        const landscapePath = await createSyntheticVideo(tmpDir, 'landscape.mp4', 1920, 1080, { audio: true });
        const portraitPath = await createSyntheticVideo(tmpDir, 'portrait.mp4', 1080, 1920, { audio: false });

        const pLand = await probe(ffprobe, landscapePath);
        const pPort = await probe(ffprobe, portraitPath);

        const inputs: MuxInput[] = [
          { file: landscapePath, kind: 'muxed', probe: pLand },
          { file: portraitPath, kind: 'video', probe: pPort },
        ];

        // PiP
        const pipOut = path.join(tmpDir, 'pip_portrait_overlay.mp4');
        const pipArgs = buildMuxArgs({
          inputs,
          subtitles: [],
          choice: chooseContainer('auto', inputs, 'pip'),
          output: pipOut,
          title: 'Portrait Overlay PiP',
          layout: 'pip',
        });
        const pipRes = await runFfmpeg(ffmpeg, pipArgs, new AbortController().signal);
        expect(pipRes.code).toBe(0);

        const pipProbe = await probe(ffprobe, pipOut);
        const pipV = pipProbe.streams.find((s) => s.codec_type === 'video');
        expect(pipV?.width).toBe(1920);
        expect(pipV?.height).toBe(1080);

        // SbS
        const sbsOut = path.join(tmpDir, 'sbs_landscape_portrait.mp4');
        const sbsArgs = buildMuxArgs({
          inputs,
          subtitles: [],
          choice: chooseContainer('auto', inputs, 'side-by-side'),
          output: sbsOut,
          title: 'Landscape Portrait SbS',
          layout: 'side-by-side',
        });
        const sbsRes = await runFfmpeg(ffmpeg, sbsArgs, new AbortController().signal);
        expect(sbsRes.code).toBe(0);

        const sbsProbe = await probe(ffprobe, sbsOut);
        const sbsV = sbsProbe.streams.find((s) => s.codec_type === 'video');
        expect(sbsV?.width).toBe(1920);
        expect(sbsV?.height).toBe(540);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('3. Multiple Video Streams in Single Input Container', () => {
    it('empirically verifies single input container holding two video streams in SbS and PiP', async () => {
      if (!ffmpeg || !ffprobe) return;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-single-multi-'));
      try {
        const multiPath = path.join(tmpDir, 'dual_video.mp4');
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
          'testsrc=duration=1:size=640x480:rate=25',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1:sample_rate=44100',
          '-map',
          '0:v',
          '-map',
          '1:v',
          '-map',
          '2:a',
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
          multiPath,
        ]);

        const multiProbe = await probe(ffprobe, multiPath);
        expect(multiProbe.streams.filter((s) => s.codec_type === 'video').length).toBe(2);

        const inputs: MuxInput[] = [{ file: multiPath, kind: 'muxed', probe: multiProbe }];

        // Side-by-side
        const sbsOut = path.join(tmpDir, 'single_input_sbs.mp4');
        const sbsArgs = buildMuxArgs({
          inputs,
          subtitles: [],
          choice: chooseContainer('auto', inputs, 'side-by-side'),
          output: sbsOut,
          title: 'Single Input SbS Test',
          layout: 'side-by-side',
        });
        const sbsFilter = sbsArgs[sbsArgs.indexOf('-filter_complex') + 1]!;
        expect(sbsFilter).toContain('[0:v:0]');
        expect(sbsFilter).toContain('[0:v:1]');
        expect(sbsFilter).not.toContain('[0:v]');

        const sbsRes = await runFfmpeg(ffmpeg, sbsArgs, new AbortController().signal);
        expect(sbsRes.code).toBe(0);

        const sbsProbe = await probe(ffprobe, sbsOut);
        const sbsAnalysis = analyzeProbe(sbsProbe, { video: true, audio: true, durationSec: 1 });
        expect(sbsAnalysis.errors).toEqual([]);

        // PiP
        const pipOut = path.join(tmpDir, 'single_input_pip.mp4');
        const pipArgs = buildMuxArgs({
          inputs,
          subtitles: [],
          choice: chooseContainer('auto', inputs, 'pip'),
          output: pipOut,
          title: 'Single Input PiP Test',
          layout: 'pip',
        });
        const pipFilter = pipArgs[pipArgs.indexOf('-filter_complex') + 1]!;
        expect(pipFilter).toContain('[0:v:0]');
        expect(pipFilter).toContain('[0:v:1]');
        expect(pipFilter).not.toContain('[0:v]');

        const pipRes = await runFfmpeg(ffmpeg, pipArgs, new AbortController().signal);
        expect(pipRes.code).toBe(0);

        const pipProbe = await probe(ffprobe, pipOut);
        const pipAnalysis = analyzeProbe(pipProbe, { video: true, audio: true, durationSec: 1 });
        expect(pipAnalysis.errors).toEqual([]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('empirically verifies container with non-adjacent video streams (Audio 0, Video 1, Video 2)', async () => {
      if (!ffmpeg || !ffprobe) return;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-non-adj-'));
      try {
        const nonAdjPath = path.join(tmpDir, 'non_adjacent.mp4');
        await execFileP(ffmpeg, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1:sample_rate=44100',
          '-f',
          'lavfi',
          '-i',
          'testsrc=duration=1:size=640x480:rate=25',
          '-f',
          'lavfi',
          '-i',
          'testsrc=duration=1:size=320x240:rate=25',
          '-map',
          '0:a',
          '-map',
          '1:v',
          '-map',
          '2:v',
          '-c:a',
          'aac',
          '-b:a',
          '64k',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          nonAdjPath,
        ]);

        const p = await probe(ffprobe, nonAdjPath);
        const inputs: MuxInput[] = [{ file: nonAdjPath, kind: 'muxed', probe: p }];

        const sbsOut = path.join(tmpDir, 'non_adj_sbs.mp4');
        const sbsArgs = buildMuxArgs({
          inputs,
          subtitles: [],
          choice: chooseContainer('auto', inputs, 'side-by-side'),
          output: sbsOut,
          title: 'Non-adjacent Streams Test',
          layout: 'side-by-side',
        });

        const filterArg = sbsArgs[sbsArgs.indexOf('-filter_complex') + 1]!;
        expect(filterArg).toContain('[0:v:0]');
        expect(filterArg).toContain('[0:v:1]');

        const res = await runFfmpeg(ffmpeg, sbsArgs, new AbortController().signal);
        expect(res.code).toBe(0);

        const outProbe = await probe(ffprobe, sbsOut);
        const analysis = analyzeProbe(outProbe, { video: true, audio: true, durationSec: 1 });
        expect(analysis.errors).toEqual([]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('empirically verifies disambiguation across mixed inputs (Input 0 audio-only, Input 1 dual-video)', async () => {
      if (!ffmpeg || !ffprobe) return;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-mixed-inputs-'));
      try {
        const audioPath = path.join(tmpDir, 'audio.m4a');
        const dualVidPath = path.join(tmpDir, 'dual_video.mp4');

        await execFileP(ffmpeg, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1:sample_rate=44100',
          '-c:a',
          'aac',
          '-b:a',
          '64k',
          audioPath,
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
          '-f',
          'lavfi',
          '-i',
          'testsrc=duration=1:size=320x240:rate=25',
          '-map',
          '0:v',
          '-map',
          '1:v',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          dualVidPath,
        ]);

        const pAudio = await probe(ffprobe, audioPath);
        const pDual = await probe(ffprobe, dualVidPath);

        const inputs: MuxInput[] = [
          { file: audioPath, kind: 'audio', probe: pAudio },
          { file: dualVidPath, kind: 'video', probe: pDual },
        ];

        const pipOut = path.join(tmpDir, 'mixed_pip.mp4');
        const pipArgs = buildMuxArgs({
          inputs,
          subtitles: [],
          choice: chooseContainer('auto', inputs, 'pip'),
          output: pipOut,
          title: 'Mixed Inputs PiP',
          layout: 'pip',
        });

        // Filter should reference [1:v:0] and [1:v:1] because input 0 has no video
        const filterArg = pipArgs[pipArgs.indexOf('-filter_complex') + 1]!;
        expect(filterArg).toContain('[1:v:0]');
        expect(filterArg).toContain('[1:v:1]');

        const res = await runFfmpeg(ffmpeg, pipArgs, new AbortController().signal);
        expect(res.code).toBe(0);

        const outProbe = await probe(ffprobe, pipOut);
        const analysis = analyzeProbe(outProbe, { video: true, audio: true, durationSec: 1 });
        expect(analysis.errors).toEqual([]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
