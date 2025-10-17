// 입력 예: [Dec 24 10:51:07.941] homey-pro[830]:  SQLite Connected
// => time | proc | pid | msg
export function parseLogLine(line: string){
  // 매우 단순 파서 (필요시 정교화)
  const timeMatch = line.match(/^\[([^\]]+)\]\s+(.*)$/);
  let time = '', rest = line;
  if (timeMatch){
    time = timeMatch[1];
    rest = timeMatch[2];
  }
  const procMatch = rest.match(/^([^\s:]+)\[(\d+)\]:\s*(.*)$/);
  let proc='', pid='', msg=rest;
  if (procMatch){
    proc = procMatch[1];
    pid = procMatch[2];
    msg = procMatch[3] ?? '';
  }
  return { time, proc, pid, msg };
}
