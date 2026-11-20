/**
 * 临时目录里验证数据目录解析：新目录优先，旧包名目录回落。
 * 不碰真实 ~/.dsh —— 全程在 mkdtemp 出来的沙箱里跑。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 在一个全新的子进程里 import 宿主模块，只吐出它解析到的数据目录。 */
function resolveDataDir(home) {
  const probe = `
    const url = ${JSON.stringify(new URL('../lib/index.js', import.meta.url).href)};
    const mod = await import(url);
    process.stdout.write(mod.__DATA_DIR__);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`子进程失败: ${r.stderr || r.status}`);
  return r.stdout.trim();
}

let pass = 0;
function check(title, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${title}`); }
  catch (error) { console.log(`  FAIL ${title}\n       ${error.message}`); process.exitCode = 1; }
}

console.log('\n[数据目录]');

const sandbox = mkdtempSync(path.join(tmpdir(), 'fairy-voice-datadir-'));
try {
  const homeNew = path.join(sandbox, 'home-new');
  const homeLegacy = path.join(sandbox, 'home-legacy');
  const homeBoth = path.join(sandbox, 'home-both');
  for (const h of [homeNew, homeLegacy, homeBoth]) mkdirSync(h, { recursive: true });
  mkdirSync(path.join(homeLegacy, 'pi-voice'), { recursive: true });
  mkdirSync(path.join(homeBoth, 'pi-voice'), { recursive: true });
  mkdirSync(path.join(homeBoth, 'fairy-voice'), { recursive: true });

  check('都没有时 → 用新的 fairy-voice', () => {
    const got = resolveDataDir(homeNew);
    if (got !== path.join(homeNew, 'fairy-voice')) throw new Error(`拿到 ${got}`);
  });

  check('只有旧包名目录 → 回落沿用 pi-voice', () => {
    const got = resolveDataDir(homeLegacy);
    if (got !== path.join(homeLegacy, 'pi-voice')) throw new Error(`拿到 ${got}`);
  });

  check('两个都在 → 一律以新的为准', () => {
    const got = resolveDataDir(homeBoth);
    if (got !== path.join(homeBoth, 'fairy-voice')) throw new Error(`拿到 ${got}`);
  });
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} 项\n`);