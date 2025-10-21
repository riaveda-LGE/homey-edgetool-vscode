# 프로젝트 구조 업데이트 지시
프로젝트에 새 파일들이 추가 되고 기존 파일들이 삭제 되었어.
아래 두개의 명령을 이용해 폴더/파일 구조를 확실히 잡고 내용을 확인한 뒤 copilot-instruction.md 에 project tree를 업데이트 해줘.
특히 프로젝트들의 내용을 깊이있게 분석해서 "Project function list" 에 있는 기능에 직접적인 연관이 있을  경우 태그를 달아줘.
Get-ChildItem -Path "d:\djwork\homey-edgetool-vscode\src" -Recurse -File `
| Where-Object { $_.FullName -notlike "*\node_modules\*" -and $_.FullName -notlike "*\test_log\* -and $_.FullName -notlike "*\out\*" } `
| Select-Object -ExpandProperty FullName
Get-ChildItem -Path "d:\djwork\homey-edgetool-vscode\doc" -Recurse -File | Select-Object FullName
Get-ChildItem -Path "d:\djwork\homey-edgetool-vscode\media" -Recurse -File | Select-Object FullName
Get-ChildItem -Path "d:\djwork\homey-edgetool-vscode" -File | Select-Object Name