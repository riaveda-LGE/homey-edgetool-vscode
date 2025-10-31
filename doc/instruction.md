# 프로젝트 구조 업데이트 지시

프로젝트에 새 파일들이 추가 되고 기존 파일들이 삭제 되었어.
아래 두개의 명령을 이용해 폴더/파일 구조를 확실히 잡고 내용을 확인한 뒤 copilot-instruction.md 에 project tree를 업데이트 해줘.
특히 프로젝트들의 내용을 깊이있게 분석해서 "Project function list" 에 있는 기능에 직접적인 연관이 있을  경우 태그를 달아줘.
Get-ChildItem -Path "d:\work\homey-edgetool-vscode\src" -Recurse -File | Where-Object { $_.FullName -notlike "*\node_modules\*" -and $_.FullName -notlike "*\test_log\*" -and $_.FullName -notlike "*\out\*" } | Select-Object -ExpandProperty FullName
Get-ChildItem -Path "d:\djwork\homey-edgetool-vscode\doc" -Recurse -File | Select-Object FullName
Get-ChildItem -Path "d:\djwork\homey-edgetool-vscode\media" -Recurse -File | Select-Object FullName
Get-ChildItem -Path "d:\djwork\homey-edgetool-vscode" -File | Select-Object Name


# 프로젝트 초기 구조 분석 지시

homey-edge-tool.txt 의 내용을 깊이있게 분석해줘. 그리고 나서 2가지를 부탁해.
1. project tree를 만들어줘. project tree를 만들때 다음과 같은 포맷으로 부탁해. 해당 내용은 md 파일에 저장할거니깐 내가 다운받을 수 있게 마크다운 형식으로만들어줘.
## Homey EdgeTool — Project function list
### function: 확장_초기화
> edgetool 확장 모듈이 VS Code에 로드되면서 초기화를 진행 및 확장 패널에 Control/Explorer/Log 뷰어를 생성하는 기능. 확장 패널의 모든 뷰가 정상적으로 보이는데 책임을 짐
> 관련 파일들
> ...
### function: 로그파싱
> 파일병합모드로 로그를 열었을 때 주어진 폴더에 있는 로그파일을 읽고 해당 로그의 내용을 파싱해서 버퍼에 저장을 할 수 있도록 하는 기능
### function: 로그병합
> 각 로그타입의 로그들이 파싱되면 이를 시간 역순으로 정렬 및 타임존 보정 후 우선순위 큐 기반 k-way merge 알고리즘으로 전체 로그를 병합하는 기능
### function: 스크롤에_따른_로그_뷰_로드_갱신
> 사용자가 로그 뷰어에서 스크롤을 내릴 때 추가 로그를 자동으로 로드하고 뷰를 업데이트하는 기능
### function: custom_log_parser_설정
> custom_log_parser파일 내용을 읽고 그 안에 정의된 내용인 requirements, preflight, parser 동작에 실질적인 로직을 제공 합니다.
### function: 타임존_점프_감지_및_보정
> 로그의 타임스탬프를 분석하여 타임존 점프를 감지하고, 이를 보정하는 기능을 제공합니다.
### function: 실시간 로그
> 디바이스로 부터 실시간 로그를 받는 받아 링버퍼에 저장 및 webviewer에게 전달하기 전까지의 로직


# Homey EdgeTool — Project Structure
```
homey-edgetool/
├─ .github/                               
│  ├─ copilot-instructions.md             #Copilot 지침 및 프로젝트 구조 문서
│  └─ workflows/                          #GitHub Actions 워크플로우
│     ├─ build-release.yml                #빌드 및 릴리스 워크플로우
│     └─ ci.yml                           #지속적 통합 워크플로우
├─ doc/                                   
│  ├─ instruction.md                      #프로젝트 지침 및 사용법
│  ├─ logging-0-parser.md                 #로그 파서 설계 및 구현 문서
│  ├─ logging_parse_integration_logic.md  #로그 파싱 통합 로직 문서
│  ├─ logparser_logic.md                  #로그 파서 로직 문서
│  └─ perf-guide.md                       #성능 가이드 문서
├─ media/                                 #아이콘 및 정적 자원
│  └─ resources/
│     ├─ custom_log_parser.template.v1.json #커스텀 로그 파서 템플릿 JSON
│     ├─ edge-icon.svg                    #확장 아이콘 SVG 파일
│     └─ help.md                          #도움말 문서

...
프로젝트 트리내 각 파일들에 대한 설명은 #으로 한줄 설명해줘. 그리고 Project function list의 기능에 대한 내용을 담고 있는 파일들은 각 기능 설명 아래에 추가해줘.
예를 들어 이런식이야.
### function: 로그병합
> 각 로그타입의 로그들이 파싱되면 이를 시간 역순으로 정렬 및 타임존 보정 후 우선순위 큐 기반 k-way merge 알고리즘으로 전체 로그를 병합하는 기능
```bash
src\core\logs\ManifestTypes.ts
src\core\logs\ManifestWriter.ts
```


2번째 요구 사항
모든 모듈간의 관계를 한눈에 알 수 있도록 모듈간 관계 다이어그램을 그려줘. 다운로드 받을 수 있게 이미지로 만들어줘.ㅍ