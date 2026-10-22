// 맥: 개발자 인증서 없이도 Apple Silicon 에서 실행되도록 DMG 를 만들기 전에 임시(ad-hoc) 서명한다.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
