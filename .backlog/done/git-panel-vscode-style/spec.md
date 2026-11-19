# Spec: Git 패널 VS Code 스타일 개편

## Problem Statement (문제 정의)

현재 **왼쪽 사이드바**의 **Git 뷰**에 표시되는 **Git 패널**은 상하 분할(**Changes 섹션** · **Graph 섹션**)과 읽기 전용 **Diff 탭**을 갖추고 있으나, 전체 레이아웃과 정보 밀도가 VS Code의 Source Control 경험에 비해 비효율적입니다.

- 상단 고정 공통 영역(브랜치 드롭다운 + `전환` 버튼 + `Pull`/`Push`/`Sync` 3열 버튼)이 세로 공간을 상시 차지해 **Changes 섹션**과 **Graph 섹션**의 가시 영역을 압박합니다.
- 변경 파일 목록이 전체 상대 경로 단일 문자열, 좌측 상태 배지, 상시 노출 테두리 버튼(`↶`, `+`), 0건일 때도 고정 표시되는 `스테이지됨` 영역으로 구성되어 밀도와 스캔성이 떨어지며, 트리 보기 전환과 편집 탭으로의 직접 파일 열기를 제공하지 않습니다.
- `Staged` 파일이 0건이면 Unstaged/Untracked 변경이 있어도 `Commit` 버튼이 비활성화되고, `Commit & Push` / `Commit & Sync` 또는 클린 상태에서의 `Publish Branch` / `Sync Changes` 스마트 전환을 지원하지 않습니다.
- **Graph 섹션**에서 Ref 배지가 커밋 제목 왼쪽에 배치되어 제목 정렬선이 흔들리고, 로컬·원격 동일 커밋 참조가 중복 나열되며, `Fetch`/`Pull`/`Push` 빠른 아이콘 툴바가 없습니다.

## Solution (해결 방안)

인터랙티브 UI 프로토타입 검토를 거쳐 확정된 **단일 저장소 VS Code 스타일(안 A + 헤더 브랜치 서브행 옵션 1)**로 **Git 패널**을 개편합니다.

1. **단일 저장소 VS Code 2단 아코디언 + `lucide-react` 아이콘 통일**:
   - 상단 고정 공통 영역을 제거하고 **Changes 섹션** · **Graph 섹션**과 **섹션 리사이저**에 세로 공간을 집중합니다.
   - 기존 유니코드 기호 버튼(`↻`, `↶`, `+`, `-`, `▾`, `▸`)을 `lucide-react` 기반의 테두리 없는 VS Code풍 아이콘 버튼으로 교체합니다.
2. **`"Source Control"` 헤더 + 26px 브랜치 서브행 (하단 상태바 미신설)**:
   - 앱 최하단 상태바는 신설하지 않고 기존 앱 셸 높이를 유지합니다.
   - **Git 패널** 최상단 헤더에 `"Source Control"` 타이틀과 우측 아이콘 버튼(`새로고침`, `...` 더 보기 메뉴: `Pull`, `Push`, `Fetch`, `Sync`, `Stage All Changes`, `Unstage All Changes`, `Discard All Changes`)을 배치합니다.
   - 저장소 상태일 때 헤더 아래 26px 브랜치 서브행을 두고 좌측 브랜치 피커 오버레이 메뉴(클릭 즉시 전환 + 기존 미저장 **문서 버퍼** 보호 확인), 우측 원격 상태 트리거(`↓N ↑M` Sync / `☁ 미게시` Publish)를 상시 표시합니다.
3. **스마트 커밋 입력폼 & 기본 CTA 버튼**:
   - 1줄 자동 높이 조절 입력창(`메시지 (Ctrl+Enter로 "<branch>"에 커밋)`)과 상황별 스마트 CTA 버튼을 배치합니다.
   - 변경이 있으면 `✓ Commit | ▾` 스플릿 드롭다운(`Commit`, `Commit & Push`, `Commit & Sync`)을 표시하고, `Staged = 0`에서 실행 시 **확인 다이얼로그**로 전체 자동 Stage 여부를 확인한 뒤 수행합니다.
   - 워킹 트리가 깨끗하고 upstream이 없으면 `☁ Publish Branch`, ahead/behind가 남아 있으면 `↻ Sync Changes N↓ M↑` 버튼으로 자동 전환합니다.
4. **Changes 섹션 파일 목록 & 리스트/트리 전환**:
   - **Changes 섹션** 헤더 우측에 리스트↔트리 보기 전환, Commit(`✓`), 새로고침(`↻`) 아이콘을 배치합니다.
   - `Staged Changes`(0건일 때 자동 숨김)와 `Changes` 접기/펼치기 하위 그룹(우측 카운트 배지 + 호버/포커스 일괄 아이콘)을 제공합니다.
   - 22~24px 컴팩트 파일 행에 파일 아이콘 + 파일명(삭제 `D` 취소선) + 흐린 상대 디렉토리 경로(리스트 모드) + 호버/포커스 아이콘(`파일 열기` · `롤백` · `Stage/Unstage`) + 우측 끝 VS Code 상태 문자/색상을 표시합니다. 트리 모드에서는 단일 하위 폴더 경로 압축(`a/b/c`)과 폴더 접기/펼치기를 지원합니다.
5. **Graph 섹션 `git fetch` 신설 · 툴바 · 우측 병합 Ref 배지**:
   - `git:fetch` 서비스·IPC를 신설하고 **Graph 섹션** 헤더에 범위 전환(`Auto` / `현재 브랜치`) + `Fetch` · `Pull` · `Push` · `새로고침` 아이콘 툴바를 배치합니다.
   - 24px 컴팩트 커밋 행 우측에 병합 Ref 배지(로컬·원격 동일 커밋 일치 시 `◎ master` + `☁`, 일반 브랜치 체크아웃 시 중복 `HEAD` 배지 생략 · Detached HEAD 시 `HEAD` 표시, 태그 아이콘 배지)를 정렬하고, 기존 인라인 커밋 상세 펼침의 변경 파일 목록도 동일한 VS Code 파일 행 스타일로 통일합니다.
6. **혼합 UI 표기 언어 & 도메인 문서 동기화**:
   - VS Code 섹션명·Git 표준 명령(`Source Control`, `Changes`, `Staged Changes`, `Graph`, `Commit`, `Commit & Push`, `Commit & Sync`, `Publish Branch`, `Sync Changes`, `Fetch`/`Pull`/`Push`)은 영문으로, placeholder·툴팁·**확인 다이얼로그**·안내/오류 문구는 한국어로 유지하며 `CONTEXT.md`를 최신화합니다.

## User Stories (사용자 스토리)

1. As a 위키 작성자, I want **Git 패널**의 기존 상단 고정 공통 영역이 사라지고 `"Source Control"` 헤더(새로고침, `...` 더 보기 메뉴) 아래 **Changes 섹션**과 **Graph 섹션**이 넓게 배치되기를 원하며, so that 노트북 등 작은 화면에서도 변경 목록과 커밋 그래프를 여유 있게 볼 수 있습니다.
2. As a 위키 작성자, I want `"Source Control"` 헤더 아래 26px 브랜치 서브행에서 현재 브랜치를 확인하고 클릭 즉시 열리는 브랜치 피커로 전환하며, 우측의 `↓N ↑M` 또는 `☁ 미게시` 버튼을 눌러 Sync/Publish를 바로 실행하기를 원하며, so that 260px 기본 **왼쪽 사이드바**에서도 긴 브랜치명과 원격 동기화 상태를 놓치지 않고 제어할 수 있습니다.
3. As a 위키 작성자, I want 워크스페이스가 열리지 않았거나 Git 저장소가 아닐 때는 기존 안내 문구와 `Git 저장소 초기화 (git init)` 버튼이 그대로 유지되고, 로딩·오류 배너와 **섹션 리사이저**가 정상 작동하기를 원하며, so that 비저장소 초기화와 오류 인지 흐름이 기존과 동일하게 안정적으로 동작합니다.
4. As a 위키 작성자, I want 커밋 메시지 입력창이 1줄로 컴팩트하게 시작해 여러 줄 입력 시 자동으로 늘어나고 현재 브랜치명이 placeholder에 안내되기를 원하며, so that 평소에는 파일 목록 공간을 아끼고 긴 메시지를 쓸 때도 쾌적하게 입력할 수 있습니다.
5. As a 위키 작성자, I want 변경 사항 유무와 원격 상태에 따라 기본 액션 버튼이 `Commit ▾`(`Commit` / `Commit & Push` / `Commit & Sync`), `Publish Branch`, `Sync Changes N↓ M↑`로 자동 전환되기를 원하며, so that 현재 저장소 상태에서 가장 자주 쓰는 다음 단계를 한 번의 클릭으로 실행할 수 있습니다.
6. As a 위키 작성자, I want 스테이지된 파일이 0건이고 워킹 트리 변경만 있을 때 `Commit` 계열 액션을 누르면 **확인 다이얼로그**로 전체 자동 Stage 여부를 확인한 뒤 승인 시 `stageAll`과 커밋을 한 번에 처리해 주기를 원하며, so that 실수 없이 빠르게 변경 사항을 커밋하면서도 의도치 않은 파일 포함을 방지할 수 있습니다.
7. As a 위키 작성자, I want 스테이지된 파일이 없을 때 `Staged Changes` 그룹이 자동으로 숨겨지고, **Changes 섹션** 헤더의 아이콘으로 리스트 보기와 경로 압축 폴더 트리 보기를 오가며, 하위 그룹을 접거나 펼치고 호버·키보드 포커스로 일괄 액션을 실행하기를 원하며, so that 불필요한 빈 영역 없이 원하는 구조로 변경 파일을 정리할 수 있습니다.
8. As a 위키 작성자, I want 변경 파일 행에 마우스를 올리거나 키보드 포커스를 두었을 때 `파일 열기`, `롤백`, `Stage`/`Unstage` 아이콘이 나타나고 행 본문을 클릭하면 **Diff 탭**이 열리며 `파일 열기` 아이콘을 누르면 일반 문서 편집 탭이 열리기를 원하며, so that 평소에는 파일명과 VS Code 상태 문자(`U`, `A`, `M`, `D`, `C`, `R`)가 깔끔히 보이고 필요할 때 Diff 검토와 문서 편집을 즉시 오갈 수 있습니다.
9. As a 위키 작성자, I want **Graph 섹션** 헤더에서 범위 전환(`Auto` / `현재 브랜치`)과 `Fetch` · `Pull` · `Push` · `새로고침` 아이콘을 바로 실행해 워킹 트리를 건드리지 않고 원격 변경 사항을 미리 받아오기를 원하며, so that 커밋 그래프와 `↓N` 상태를 언제든 최신으로 유지할 수 있습니다.
10. As a 위키 작성자, I want **Graph 섹션** 커밋 행에서 SVG 레인, 커밋 제목, 흐린 작성자, 우측 정렬 병합 Ref 배지(`◎ master` + `☁`, 태그 배지)가 정돈되어 보이고, 커밋 행을 클릭하면 VS Code 파일 행 스타일의 인라인 상세 목록이 펼쳐지기를 원하며, so that 커밋 제목 정렬선이 흔들리지 않고 분기와 원격 동기화 상태를 한눈에 파악할 수 있습니다.

## Implementation Decisions (구현 결정사항)

### 1. `git:fetch` 공유 계약 및 실행 규칙
- **공유 Git API 확장 형태** (설계 확정 스키마):

  ```ts
  export interface WikiGitApi {
    // 기존 메서드 유지 ...
    fetch: (workspacePath: string) => Promise<GitStatus>
  }
  ```

- **보안 검증 및 실행 계약**:
  - IPC 핸들러는 기존 Git 채널과 동일하게 요청의 `workspacePath`가 발신 세션의 현재 활성 워크스페이스 루트와 일치하는지 검증합니다.
  - Git 서비스의 `fetch`는 저장소 루트와 원격 저장소 존재 여부를 검증한 뒤(원격 미설정 시 기존 `Pull`/`Push`/`Sync`와 동일한 한국어 오류 반환) 네트워크 타임아웃 하에 원격 참조를 갱신(`git fetch`)하고 최신 `GitStatus`를 반환합니다.
  - `fetch`는 워킹 트리 파일을 변경하지 않으므로 미저장 **문서 버퍼** 확인을 띄우지 않으며, 완료 후 최신 상태(`behind` 등)와 **Graph 섹션** 커밋 로그 및 브랜치 목록을 함께 갱신합니다.

### 2. 헤더 · `...` 더 보기 메뉴 · 26px 브랜치 서브행 계약
- **패널 접근성 및 비저장소 상태**:
  - **Git 패널** 최상위 영역의 접근 가능한 이름(`aria-label="Git 소스 제어"`)과 비저장소(`git init`) / 워크스페이스 미열림 상태 UI는 기존과 동일하게 유지합니다.
  - 기존 상단 고정 공통 영역(브랜치 `<select>`, `전환` 버튼, `Pull`/`Push`/`Sync` 3열 버튼)은 제거합니다.
- **`"Source Control"` 헤더 및 `...` 더 보기 메뉴**:
  - 타이틀 `"Source Control"` 우측에 `새로고침` 아이콘 버튼과 `...` 더 보기 메뉴 버튼을 배치합니다.
  - `...` 더 보기 메뉴는 `Pull`, `Push`, `Fetch`, `Sync`, 구분선, `Stage All Changes`, `Unstage All Changes`, `Discard All Changes` 항목을 제공하며, 외부 클릭 또는 `Escape` 키로 닫힙니다.
  - `Discard All Changes`는 기존과 동일하게 추적·미추적 파일 개수를 구분 안내하는 위험 강조(`danger`) **확인 다이얼로그**를 거칩니다.
- **26px 브랜치 서브행**:
  - 저장소일 때 헤더 아래에 26px 높이의 브랜치 서브행을 렌더링하며, 로딩·오류 배너는 서브행 아래 상단에 고정합니다.
  - 좌측 브랜치 피커 버튼(`⎇ <branch>` 또는 Detached 시 `(detached)`)을 클릭하면 로컬 브랜치 목록 오버레이 메뉴가 열리고, 다른 브랜치를 선택하는 즉시 체크아웃(기존 미저장 **문서 버퍼** 보호 확인 유지)을 실행하고 메뉴를 닫습니다.
  - 우측 원격 상태 트리거는 upstream이 연결된 경우 `↓${behind} ↑${ahead}`를 표시하며 클릭 시 `Sync`를 실행합니다. upstream이 없고 unborn/detached가 아닌 경우 `☁ 미게시`를 표시하며 클릭 시 `Publish`/`Push`를 실행합니다(unborn 또는 detached 상태에서는 비활성화).

### 3. 스마트 커밋 CTA 상태 머신 및 복합 실행 규칙
- **스마트 기본 액션 상태 머신** (UI 프로토타입에서 확정된 상태 전이 모델):

  ```ts
  export type GitPrimaryActionState =
    | { kind: 'publish' }
    | { kind: 'sync'; ahead: number; behind: number }
    | {
        kind: 'commit'
        disabled: boolean
        requiresAutoStageConfirm: boolean
      }
  ```

- **상태 판정 불변식**:
  - `hasChanges = staged.length + unstaged.length + untracked.length > 0`
  - `!hasChanges && !hasConflicts && !isUnborn && !isDetached && !hasUpstream` → `{ kind: 'publish' }` (`☁ Publish Branch`)
  - `!hasChanges && !hasConflicts && hasUpstream && (ahead > 0 || behind > 0)` → `{ kind: 'sync', ahead, behind }` (`↻ Sync Changes ${behind}↓ ${ahead}↑`)
  - 그 외 모든 경우 → `{ kind: 'commit', disabled: !hasChanges || hasConflicts, requiresAutoStageConfirm: hasChanges && staged.length === 0 && !hasConflicts }`
- **커밋 입력폼 & 스플릿 드롭다운**:
  - 입력창은 1줄 기본 높이에서 입력 내용에 따라 최대 높이 내에서 자동 확장되며, placeholder는 `메시지 (Ctrl+Enter로 "${branchLabel}"에 커밋)` 형식을 사용합니다. `Ctrl+Enter` / `Cmd+Enter`는 현재 기본 커밋 동작을 실행합니다.
  - `kind === 'commit'`일 때 `✓ Commit | ▾` 스플릿 버튼을 렌더링하며, `▾` 드롭다운에서 `Commit`, `Commit & Push`, `Commit & Sync`를 선택할 수 있습니다. `disabled === true`(변경 없음 또는 병합 충돌)일 때는 본 버튼과 드롭다운 토글을 모두 비활성화합니다.
- **자동 Stage 확인 및 복합 실행 불변식**:
  - `requiresAutoStageConfirm === true` 상태에서 `Commit`, `Commit & Push`, `Commit & Sync` 또는 `Ctrl+Enter`를 실행하면 먼저 빈 커밋 메시지 인라인 검증을 통과한 뒤 **확인 다이얼로그**로 `"스테이지된 변경 사항이 없습니다. 모든 변경 사항을 자동으로 Stage하고 커밋할까요?"` 확인을 거칩니다.
  - 승인 시 단일 직렬 뮤테이션 잠금(`pendingAction`) 내에서 `stageAll` → `commit` → (선택 시) `push` 또는 `sync`를 순차 실행합니다.
  - `Commit & Push` 또는 `Commit & Sync` 실행 중 커밋 단계가 성공하고 후속 원격 단계가 실패하거나(`Commit & Sync` 미저장 버퍼 확인에서 사용자가 취소한 경우 포함) 중단되면, 이미 커밋이 생성되었으므로 커밋 입력 메시지는 비우고 원격 작업 실패만 오류 배너에 표시합니다.

### 4. Changes 섹션 파일 목록, 상태 표시 매핑, 경로 압축 트리 모델
- **헤더 및 하위 그룹 구성**:
  - **Changes 섹션** 헤더 우측에 `리스트/트리 보기 전환`, `Commit ✓`(스마트 커밋 흐름 실행), `새로고침 ↻` 아이콘 버튼을 배치합니다.
  - `Staged Changes` 그룹은 스테이지된 파일이 `0`건일 때 렌더링하지 않으며(`1`건 이상일 때 표시), `Changes` 그룹과 함께 각각 접기/펼치기, 우측 카운트 배지, 호버/키보드 포커스(`:focus-within`) 일괄 아이콘(`Staged Changes`: `-`, `Changes`: `↶` · `+`)을 제공합니다.
- **UI 전용 상태 문자 및 색상 매핑** (내부 `GitFileStatusCode` 불변, 프로토타입 확정 매핑):
  - `M` → `"M"` (앰버, Modified)
  - `A` → `"A"` (초록, Added)
  - `D` → `"D"` (빨강 + 파일명 취소선, Deleted)
  - `R` → `"R"` (강조, Renamed)
  - `C` → `"C"` (강조, Copied)
  - `?` → `"U"` (초록, Untracked — 내부 데이터 타입은 `'?'` 유지)
  - `U` → `"C"` (빨강, Conflict — 내부 데이터 타입은 `'U'` 유지)
- **파일 행 인터랙션 & 액션 분리**:
  - 리스트 모드 파일 행은 파일 아이콘 + 파일명(이름 변경 시 `origPath → path` 기반 표시) + 흐린 상대 디렉토리 경로 + 호버/포커스 액션 + 우측 끝 상태 문자로 구성됩니다.
  - 행 본문 클릭 → 기존과 동일하게 활성 **편집기 영역**에 읽기 전용 **Diff 탭**을 열거나 교체합니다.
  - 호버/포커스 액션 → `파일 열기`(삭제 `D` 파일 및 현재 열린 워크스페이스 루트 밖 경로에서는 미표시/비활성화, 클릭 시 일반 문서 편집 탭 열기), `롤백`(Unstaged/Untracked 전용), `Stage`(`+`) / `Unstage`(`-`) 아이콘을 제공합니다.
- **경로 압축 폴더 트리 모델** (프로토타입에서 확정된 트리 노드 형태):

  ```ts
  export type GitFileTreeNode =
    | {
        kind: 'dir'
        path: string
        label: string
        children: GitFileTreeNode[]
      }
    | {
        kind: 'file'
        file: GitChangedFile
      }
  ```

  - 파일이 없는 중간 폴더가 단일 하위 폴더만 가지면 `a/b/c` 형태로 경로를 압축하며, 각 계층은 폴더 우선 → 이름 오름차순으로 정렬합니다. 이름 변경 파일은 목적지 `path` 위치에 배치하고 툴팁에 `origPath → path` 전체 맥락을 유지합니다.
  - `viewMode` (`'list' | 'tree'`), `Staged Changes`/`Changes` 그룹 접힘, 트리 폴더 접힘 상태는 `GitPanelSplitState`와 동일하게 세션 메모리 전용으로 관리합니다(`config.json`에 저장하지 않으며, 워크스페이스 전환 시 트리 폴더 접힘 집합을 초기화).

### 5. Graph 섹션 툴바 및 우측 병합 Ref 배지 규칙
- **헤더 툴바**:
  - **Graph 섹션** 헤더 접기 버튼 우측에 범위 전환 버튼(`Auto` ↔ `현재 브랜치`, 내부 `GitLogScope` `'all' | 'current'` 계약 유지)과 `Fetch` · `Pull` · `Push` · `새로고침` 아이콘 버튼을 배치합니다.
- **우측 정렬 병합 Ref 배지 정규화 모델** (프로토타입에서 확정된 표시 배지 모델):

  ```ts
  export type GitGraphDisplayRef =
    | {
        kind: 'branch'
        name: string
        isCurrentHead: boolean
        syncedRemotes: string[]
      }
    | { kind: 'remote'; name: string }
    | { kind: 'head' }
    | { kind: 'tag'; name: string }
  ```

  - 동일 커밋의 원격 추적 참조(`<remote>/<branch>`의 첫 `/` 이후 단축 이름)가 같은 커밋의 로컬 브랜치명과 일치하면 독립 원격 배지 대신 해당 로컬 브랜치 배지의 `syncedRemotes`로 병합해 `◎ <branch>`(비체크아웃 로컬은 브랜치 아이콘) 옆 `☁` 배지(툴팁에 원격명 목록)로 렌더링합니다. 일치 로컬 브랜치가 없는 원격 참조는 독립 원격 배지(`☁ <name>`)로 표시합니다.
  - 동일 커밋에 `isCurrentHead === true`인 로컬 브랜치가 있으면 중복 `HEAD` 배지를 생략하고, Detached HEAD(현재 로컬 브랜치 부재)일 때만 `◎ HEAD` 배지를 표시합니다.
  - 태그 참조는 태그 아이콘과 함께 구분 색상 배지로 우측 정렬합니다.
- **커밋 행 & 인라인 상세**:
  - 24px 컴팩트 행에 SVG 레인, 커밋 제목(말줄임), 흐린 작성자, 우측 정렬 Ref 배지를 배치합니다.
  - 커밋 클릭 시 펼쳐지는 인라인 상세(단축 해시 + `lucide-react` 복사 버튼, 제목·본문, 작성자·일시, 변경 파일 목록)는 **Changes 섹션**과 동일한 VS Code 파일 행 및 상태 표기 규칙을 따릅니다.

### 6. 테마 · 아이콘 · 혼합 UI 표기 언어 · 도메인 용어집 정합성
- 라이트/다크 테마 모두에서 VS Code Git 상태 색상 토큰(Modified 앰버, Added/Untracked 초록, Deleted/Conflict 빨강, Renamed/Branch 강조)과 호버·선택·포커스 대비가 명확히 동작하도록 정의합니다.
- 도메인 용어집(`CONTEXT.md`)의 **Git 패널**, **Changes 섹션**, **Graph 섹션**, **확인 다이얼로그** 설명을 개편된 UI 및 자동 Stage 확인 흐름에 맞게 갱신합니다.

## Testing Decisions (테스트 결정사항)

- **검증 기준**: 내부 DOM 구조나 CSS 클래스에 의존하지 않고 접근 가능한 역할·이름(`getByRole`, `getByLabelText`, `getByPlaceholderText`)과 공개 서비스·IPC 계약을 통해 사용자 관점의 관찰 가능한 동작을 검증합니다. 모든 테스트는 인메모리 하네스와 격리된 임시 Git 저장소·로컬 bare remote로 수행합니다.
- **사전 합의된 테스트 심 (Pre-agreed Seams)**:
  1. **`<App />` + 인메모리 `window.wikiApi` 통합 심 (`createInMemoryWikiHarness` / `createMultiWindowWikiHarness` + React Testing Library)**
     - **Catches**: `"Source Control"` 헤더 및 `...` 메뉴, 26px 브랜치 서브행 즉시 전환 및 미저장 버퍼 보호, 스마트 커밋 CTA(`Commit ▾`, `Staged=0` 자동 Stage **확인 다이얼로그**, `Publish Branch`/`Sync Changes`), **Changes 섹션** `Staged Changes` 자동 숨김·리스트↔트리 전환·호버 `파일 열기` 일반 탭 열기·행 클릭 **Diff 탭**·롤백·상태 표기, **Graph 섹션** `Fetch`/`Pull`/`Push` 툴바 및 우측 병합 Ref 배지, 인라인 커밋 상세 등 UI↔컨트롤러↔탭 통합 회귀.
     - **Misses**: 실제 `git` CLI 프로세스 실행, 실제 브라우저 CSS `:hover` 시각 렌더링, Electron IPC 실제 직렬화 전송.
  2. **Git 서비스 통합 심 (임시 디렉터리 격리 실제 Git 저장소 + 로컬 bare 원격 저장소 / Vitest)**
     - **Catches**: 실제 `git fetch` 실행 후 원격 커밋·참조 및 `behind` 상태 반영, 원격 미설정·비저장소 오류 처리, 워킹 트리 파일 무변경 보장.
     - **Misses**: Electron IPC 채널 검증과 렌더러 컴포넌트 상태 전이.
  3. **Git IPC 핸들러 & Preload 브리지 경계 심 (가짜 `IpcMainLike` / `IpcRendererLike` / Vitest)**
     - **Catches**: `git:fetch` 채널의 활성 워크스페이스 일치 검증·라우팅 누락 및 `window.wikiApi.git.fetch` 브리지 인자·반환값 매핑 불일치.
     - **Misses**: 실제 `git` 바이너리 동작과 렌더러 UI 상호작용.
  4. **순수 Git UI 상태·변환 모듈 경계 심 (Vitest 단위 테스트)**
     - **Catches**: 스마트 CTA 상태 머신 전이(`publish`/`sync`/`commit`/`requiresAutoStageConfirm`), 상태 코드→VS Code UI 문자/색상 매핑, 경로 압축 폴더 트리 구성·정렬·리네임 처리, 로컬·원격 Ref 배지 병합 및 Detached `HEAD` 처리 엣지 케이스.
     - **Misses**: DOM 이벤트·오버레이 메뉴 닫기·실제 IPC/Git 연동.
- *(위 심 목록은 Step 4에서 확인되어 `/ticket-runner`의 사전 합의된 심(Pre-agreed Seams)으로 사용됩니다.)*
- **참고할 기존 테스트 패턴 (Prior Art)**:
  - `<App />` 인메모리 및 멀티 윈도우 통합 테스트 하네스 패턴
  - 임시 저장소(`mkdtemp` + 로컬 bare remote + 로컬 `.gitconfig`)를 사용하는 Git 서비스 통합 테스트 패턴
  - 가짜 `IpcMainLike` / `IpcRendererLike` 기반 IPC 핸들러 및 Preload 브리지 경계 테스트 패턴
  - 순수 프레젠테이션·레이아웃 유틸리티의 테이블 기반 Vitest 단위 테스트 패턴

## Out of Scope (범위 제외 사항)

- 다중 저장소 또는 Git Worktree 목록을 표시하는 `Repositories` 섹션 추가
- 앱 최하단 상태바(Status Bar) 신설
- AI 커밋 메시지 자동 생성(`Generate`) 버튼
- 트리 보기에서 폴더 단위로 일괄 Stage/Unstage/롤백을 실행하는 폴더 행 액션
- 리스트/트리 보기 모드나 하위 그룹·폴더 접힘 상태의 `config.json` 영구 저장
- 커밋 그래프 내 체리픽·리베이스·브랜치 생성 등 쓰기 액션 (기존 조회 전용 유지)

## Further Notes (기타 참고사항)

- **키보드 접근성**: 파일 행과 하위 그룹 헤더의 호버 전용 아이콘 버튼은 마우스 호버뿐 아니라 CSS `:focus-within`에서도 노출되어 키보드 탭 이동으로 모든 액션을 실행할 수 있어야 합니다.
- **260px 기본 사이드바 탄력성**: 기본 **왼쪽 사이드바** 너비(260px)에서 브랜치 서브행, 파일명과 흐린 디렉토리 경로, 커밋 제목과 우측 병합 Ref 배지가 넘치거나 깨지지 않고 `min-width: 0` 및 말줄임(`text-overflow: ellipsis`)으로 자연스럽게 수렴해야 합니다.
