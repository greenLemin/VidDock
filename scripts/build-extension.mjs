import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAllIcons } from './generate-icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extSrc = path.join(root, 'apps', 'extension');
const extDist = path.join(extSrc, 'dist');
const rootDistExt = path.join(root, 'dist', 'extension');

const isWatch = process.argv.includes('--watch');
const isMinify = process.argv.includes('--minify');
const isSourcemap = !isMinify || process.argv.includes('--sourcemap');

async function cleanDist() {
  fs.rmSync(extDist, { recursive: true, force: true });
  fs.mkdirSync(extDist, { recursive: true });
  fs.mkdirSync(path.join(extDist, 'icons'), { recursive: true });
  fs.mkdirSync(path.join(extDist, 'popup'), { recursive: true });
  fs.mkdirSync(path.join(extDist, 'dashboard'), { recursive: true });
  fs.mkdirSync(path.join(extDist, 'settings'), { recursive: true });
}

function copyStaticAssets() {
  // 1. Ensure icons exist
  const icon16 = path.join(extSrc, 'icons', 'icon-16.png');
  if (!fs.existsSync(icon16)) {
    console.log('Icons missing in apps/extension/icons, generating...');
    generateAllIcons(path.join(extSrc, 'icons'));
  }

  // 2. Copy icons to dist/icons
  const iconFiles = fs.readdirSync(path.join(extSrc, 'icons'));
  for (const file of iconFiles) {
    fs.copyFileSync(path.join(extSrc, 'icons', file), path.join(extDist, 'icons', file));
  }

  // 3. Copy manifest.json
  const manifestPath = path.join(extSrc, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    fs.copyFileSync(manifestPath, path.join(extDist, 'manifest.json'));
  } else {
    throw new Error(`Fatal: manifest.json not found at ${manifestPath}`);
  }

  // 4. Copy HTML files
  for (const view of ['popup', 'dashboard', 'settings']) {
    const htmlSrc = path.join(extSrc, 'src', view, 'index.html');
    if (fs.existsSync(htmlSrc)) {
      fs.copyFileSync(htmlSrc, path.join(extDist, view, 'index.html'));
    }
  }
}

function getBuildConfigs() {
  const common = {
    bundle: true,
    target: 'es2022',
    platform: 'browser',
    sourcemap: isSourcemap,
    minify: isMinify,
    legalComments: 'none',
    logLevel: 'info',
  };

  return [
    // Background Service Worker (ESM format for MV3 module service worker)
    {
      ...common,
      entryPoints: [path.join(extSrc, 'src', 'background', 'index.ts')],
      outfile: path.join(extDist, 'background.js'),
      format: 'esm',
    },
    // Content Scripts (IIFE format for Chrome isolated worlds)
    {
      ...common,
      entryPoints: [path.join(extSrc, 'src', 'content', 'video_detector.ts')],
      outfile: path.join(extDist, 'content_video.js'),
      format: 'iife',
    },
    {
      ...common,
      entryPoints: [path.join(extSrc, 'src', 'content', 'mediasite_detector.ts')],
      outfile: path.join(extDist, 'content_mediasite.js'),
      format: 'iife',
    },
    // Popup (JS & CSS)
    {
      ...common,
      entryPoints: [path.join(extSrc, 'src', 'popup', 'index.ts')],
      outfile: path.join(extDist, 'popup', 'index.js'),
      format: 'esm',
    },
    {
      ...common,
      entryPoints: [path.join(extSrc, 'src', 'popup', 'style.css')],
      outfile: path.join(extDist, 'popup', 'index.css'),
    },
    // Dashboard (JS & CSS)
    {
      ...common,
      entryPoints: [path.join(extSrc, 'src', 'dashboard', 'index.ts')],
      outfile: path.join(extDist, 'dashboard', 'index.js'),
      format: 'esm',
    },
    {
      ...common,
      entryPoints: [path.join(extSrc, 'src', 'dashboard', 'style.css')],
      outfile: path.join(extDist, 'dashboard', 'index.css'),
    },
    // Settings (JS & CSS)
    {
      ...common,
      entryPoints: [path.join(extSrc, 'src', 'settings', 'index.ts')],
      outfile: path.join(extDist, 'settings', 'index.js'),
      format: 'esm',
    },
    {
      ...common,
      entryPoints: [path.join(extSrc, 'src', 'settings', 'style.css')],
      outfile: path.join(extDist, 'settings', 'index.css'),
    },
  ];
}

export function validateUnpackedExtension(distPath = extDist) {
  const manifestFile = path.join(distPath, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error('dist/manifest.json is missing');

  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.manifest_version !== 3) throw new Error('Manifest version must be 3');

  // Background
  const sw = manifest.background?.service_worker;
  if (!sw || !fs.existsSync(path.join(distPath, sw))) {
    throw new Error(`Background service worker missing: ${sw}`);
  }

  // Content scripts
  if (Array.isArray(manifest.content_scripts)) {
    for (const cs of manifest.content_scripts) {
      for (const js of cs.js ?? []) {
        if (!fs.existsSync(path.join(distPath, js))) {
          throw new Error(`Content script missing: ${js}`);
        }
      }
    }
  }

  // Icons
  for (const size of ['16', '48', '128']) {
    const iconRel = manifest.icons?.[size] ?? manifest.action?.default_icon?.[size];
    if (iconRel) {
      const iconAbs = path.join(distPath, iconRel);
      if (!fs.existsSync(iconAbs) || fs.statSync(iconAbs).size === 0) {
        throw new Error(`Icon missing or empty: ${iconRel}`);
      }
      // Check PNG magic bytes
      const fd = fs.openSync(iconAbs, 'r');
      const magic = Buffer.alloc(4);
      fs.readSync(fd, magic, 0, 4, 0);
      fs.closeSync(fd);
      if (magic[0] !== 0x89 || magic[1] !== 0x50 || magic[2] !== 0x4e || magic[3] !== 0x47) {
        throw new Error(`Icon is not a valid PNG: ${iconRel}`);
      }
    }
  }

  // Check HTML for inline script tags (strictly prohibited under MV3 CSP)
  for (const view of ['popup', 'dashboard', 'settings']) {
    const htmlPath = path.join(distPath, view, 'index.html');
    if (fs.existsSync(htmlPath)) {
      const content = fs.readFileSync(htmlPath, 'utf8');
      if (/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/i.test(content)) {
        throw new Error(`CSP Violation: Disallowed inline script detected in ${view}/index.html`);
      }
    }
  }

  return true;
}

function mirrorToRootDist() {
  fs.mkdirSync(path.dirname(rootDistExt), { recursive: true });
  fs.rmSync(rootDistExt, { recursive: true, force: true });
  fs.cpSync(extDist, rootDistExt, { recursive: true });
}

async function runBuild() {
  const startTime = Date.now();
  console.log(`Building VidDock Chrome Extension (mode: ${isMinify ? 'production' : 'development'})...`);

  await cleanDist();
  copyStaticAssets();

  const configs = getBuildConfigs();
  for (const cfg of configs) {
    if (fs.existsSync(cfg.entryPoints[0])) {
      await build(cfg);
    } else {
      console.warn(`[warn] Entry point not found: ${path.relative(root, cfg.entryPoints[0])}`);
    }
  }

  validateUnpackedExtension();
  mirrorToRootDist();

  console.log(`Extension build complete in ${Date.now() - startTime}ms -> apps/extension/dist/ & dist/extension/`);
}

async function runWatch() {
  console.log('Starting watch mode for VidDock Chrome Extension...');
  await cleanDist();
  copyStaticAssets();

  const configs = getBuildConfigs();
  const contexts = [];
  for (const cfg of configs) {
    if (fs.existsSync(cfg.entryPoints[0])) {
      const ctx = await context(cfg);
      await ctx.watch();
      contexts.push(ctx);
    }
  }

  fs.watch(path.join(extSrc, 'manifest.json'), () => {
    console.log('manifest.json changed, reloading...');
    copyStaticAssets();
    mirrorToRootDist();
  });

  console.log('Watching for changes in apps/extension/src/...');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (isWatch) {
    runWatch().catch((err) => {
      console.error('Watch error:', err);
      process.exit(1);
    });
  } else {
    runBuild().catch((err) => {
      console.error('Build failed:', err);
      process.exit(1);
    });
  }
}
