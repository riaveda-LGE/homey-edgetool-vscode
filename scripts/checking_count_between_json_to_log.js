import fs from 'fs';
import path from 'path';

// 명령줄 인자 확인
if (process.argv.length < 4) {
  console.log('사용법: node scripts/compare_files.js <json_폴더_경로> <log_폴더_경로>');
  process.exit(1);
}

const parcedDir = process.argv[2];
const mergeDir = process.argv[3];

const files = ['bt_player', 'clip', 'cpcd', 'kernel', 'matter', 'otbr-agent', 'system'];

files.forEach(file => {
  try {
    const jsonPath = path.resolve(parcedDir, file + '.json');
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const jsonCount = jsonData.length;

    const logPath = path.resolve(mergeDir, file + '.log');
    const logContent = fs.readFileSync(logPath, 'utf8');
    const logCount = logContent.split('\n').filter(line => line.trim()).length;

    const match = jsonCount === logCount;
    console.log(file + ': JSON 항목수=' + jsonCount + ', LOG 행수=' + logCount + ', 일치=' + match);
  } catch (e) {
    console.log(file + ': 오류 - ' + e.message);
  }
});