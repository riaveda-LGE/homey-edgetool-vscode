import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const parcedDir = 'src/__test__/test_log/normal_test_suite/before_parced';
const mergeDir = 'src/__test__/test_log/normal_test_suite/before_merge';

const files = ['bt_player', 'clip', 'cpcd', 'kernel', 'matter', 'otbr-agent', 'system'];

files.forEach(file => {
  try {
    const jsonPath = path.join(__dirname, parcedDir, file + '.json');
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const jsonCount = jsonData.length;

    const logPath = path.join(__dirname, mergeDir, file + '.log');
    const logContent = fs.readFileSync(logPath, 'utf8');
    const logCount = logContent.split('\n').filter(line => line.trim()).length;

    const match = jsonCount === logCount;
    console.log(file + ': JSON 항목수=' + jsonCount + ', LOG 행수=' + logCount + ', 일치=' + match);
  } catch (e) {
    console.log(file + ': 오류 - ' + e.message);
  }
});