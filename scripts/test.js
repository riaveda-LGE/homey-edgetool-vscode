// scripts/deploy.js (ESM 버전)
import { execSync } from 'child_process';
import fs from 'fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = pkg.version;
const vsix = `homey-edgetool-${version}.vsix`;

function isInstalled(extId) {
  try {
    const result = execSync('code --list-extensions', { encoding: 'utf8' });
    return result.split(/\r?\n/).includes(extId);
  } catch {
    return false;
  }
}

try {
  const extId = `${pkg.publisher}.${pkg.name}`;
  if (isInstalled(extId)) {
    console.log('🔄 Uninstall old extension...');
    execSync(`code --uninstall-extension ${extId}`, { stdio: 'inherit' });
  } else {
    console.log(`ℹ️ ${extId} is not installed, skipping uninstall.`);
  }

  console.log('🧹 Clean dist...');
  execSync('rimraf dist', { stdio: 'inherit' });

  console.log('📦 Deploy extension...');
  execSync('npm run deploy', { stdio: 'inherit' });

  console.log(`📥 Install ${vsix}...`);
  execSync(`code --install-extension ${vsix}`, { stdio: 'inherit' });

  console.log('✅ Deploy finished');
} catch (err) {
  console.error('❌ Deploy failed:', err.message);
  process.exit(1);
}
