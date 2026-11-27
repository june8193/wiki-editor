# Spec: 경량 심볼 탐색 및 Diff·스냅샷 코드 검색 (Lightweight Symbol Navigation & Diff Search)

## Problem Statement (문제 정의)

현재 `wiki-editor`의 **Git 뷰**(**Changes 섹션**·**Stashes 섹션**·**Graph 섹션**)와 **Compare 뷰**(**Compare 패널**)에서 코드 **Diff 탭**을 열람할 때, 변경된 함수·변수·타입이 어디에 선언되어 있고 다른 어느 파일에서 호출되는지 `Ctrl+클릭`으로 타고 들어가며 흐름을 추적할 수단이 없습니다.

- 과거 커밋·다른 브랜치(`Compare`)·Stash의 **Diff 뷰어**에서 참조 코드를 열람하려 할 때 로컬 워킹트리 파일만 열면 체크아웃된 브랜치와 시점이 달라 줄 번호가 어긋나거나 파일이 존재하지 않으며, 반대로 시점 스냅샷과 로컬 편집 파일의 UI가 구분되지 않으면 사용자가 편집 가능 여부를 혼동할 위험이 있습니다.
- 비마크다운 코드 문서나 **Diff 탭**을 열었을 때 **우측 사이드바**의 **문서 목차**와 **문서 속성 섹션**이 마크다운 전용 안내만 표시한 채 비어 있고, **Diff 탭**에서는 기본적인 `Ctrl+F` **문서 내 찾기 바**와 심볼 단위 빠른 검색도 제공되지 않습니다.
- 한편 LSP(언어 서버 프로세스)나 상시 백그라운드 인덱서를 도입하면 메모리·시작 비용이 급증하여 가벼운 마크다운 데스크톱 위키 에디터라는 `wiki-editor`의 본질이 훼손됩니다.

## Solution (해결 방안)

1. **Zero Idle Cost 온디맨드 분석 아키텍처**:
   - 상주 언어 서버(LSP)나 워크스페이스 열기 시점의 백그라운드 인덱싱을 일절 두지 않아 마크다운 위키 편집 시 대기 메모리·CPU 부하 증가를 `0`으로 유지합니다.
   - 렌더러에 이미 내장·지연 로드되는 Lezer 구문 파서(`@codemirror/lang-*`, `@codemirror/language-data`)로 구문 트리 기반 선언/참조 판별 및 심볼 추출을 수행하고, 메인 프로세스는 경량 `git grep -n -w`·`git show`(비Git/미추적/열린 미저장 **문서 버퍼**는 기존 온디맨드 스캐너 보정)만 실행해 메인 번들 비대화와 신규 런타임 의존성 추가(`node-pty` 단독 유지)를 방지합니다.
2. **작동 범위 및 일반 코드 `Raw` 구문 강조**:
   - **Diff 뷰어**, **스냅샷 뷰어**, 그리고 **폴더 트리**·**검색 패널** 등에서 연 비마크다운 일반 코드 문서(`Raw` **에디터 모드**)에서 심볼 탐색이 동작하며, 마크다운 문서(`.md`, `.markdown`, 확장자 없음)는 기존의 위키 편집·링크 이동 동작을 100% 그대로 유지합니다.
   - 비마크다운 코드 문서를 `Raw` **에디터 모드**로 열 때 기존 `markdown`/`json` 외에 파일 확장자별 Lezer 구문 강조를 적용합니다.
3. **시점 분리 UI (`🔒 <ref>` 스냅샷 탭, 프로토타입 안 B 확정) 및 탐색 히스토리**:
   - 점프 대상 줄이 현재 보고 있는 Diff/Compare 범위의 변경 Hunk 안에 포함되면 해당 **Diff 탭**의 대상 줄로 바로 이동·강조합니다.
   - 변경 Hunk 바깥 줄이거나 미변경 파일일 때:
     - 워킹트리(**Changes 섹션** `unstaged`) 또는 로컬 일반 코드 탭에서 출발한 경우 일반 문서 탭(`Raw` **에디터 모드**, `저장` 버튼 표시)으로 엽니다.
     - 과거 커밋, **Compare 패널** 브랜치·워크트리 Ref, Stash, 또는 `staged` 인덱스 기준에서 출발한 경우 **`🔒 <ref>` 배지와 상단 읽기 전용 안내 띠가 있는 스냅샷 탭**(Preview + Pin 모델 재사용, `저장`·**에디터 모드** 전환 버튼 숨김, 워킹트리 내 파일 존재 시 `[로컬 파일 열기]` 액션 제공)으로 분리해 로컬 파일과의 혼동을 원천 차단합니다.
     - **Diff 뷰어**의 삭제(`-` / `old`) 줄에서 클릭하면 이전 시점 Ref(`HEAD`, `<commit>^1`, `mergeBaseHash ?? baseRef`, `<stash>^1`), 추가·문맥(`+` / `new`) 줄에서 클릭하면 대상 시점 Ref(`워킹트리`, `<stage>`, `<commitHash>`, `<compareRef>`, `<stashHash>` 및 미추적 `^3`) 기준으로 일관되게 해석합니다.
   - 각 **편집기 영역** 헤더 좌측에 `←`/`→` **탐색 히스토리** 버튼을 두고 `Alt+←`/`Alt+→` 및 마우스 뒤로/앞으로 버튼으로 이전 탭·줄 위치까지 단계별 복귀·전진을 지원합니다.
4. **`Ctrl+클릭`(정의 이동)과 `레퍼런스 찾기` 분리 + 유연한 폴백**:
   - `Ctrl+클릭`(`Cmd+클릭`)은 **정의(선언부) 이동** 전용으로 동작해 단일 선언부면 즉시 점프하고 다중 선언 후보면 커서 근처 후보 선택 팝오버를 표시합니다. 저장소 내 명확한 선언부를 찾지 못했으나 다른 참조가 존재하면 막히지 않고 **우측 사이드바** **레퍼런스 섹션**에 참조 목록을 자동 표시하며 안내하고, 다른 참조도 없으면 커서 근처에 짧은 인라인 안내 툴팁만 표시합니다.
   - 우클릭 컨텍스트 메뉴 `'레퍼런스 찾기'` 및 `Shift+F12`는 코드 탭·**Diff 탭**·**스냅샷 탭** 활성 시 비활성인 **문서 속성 섹션** 자리(**우측 사이드바** 하단)를 **레퍼런스 섹션**으로 전환해(접혀 있으면 자동 펼침, 현재 Diff/Compare 변경 파일 상단 우선 배치) **왼쪽 사이드바**의 **Git 뷰**·**Compare 뷰**를 가리지 않고 여러 호출부를 닫힘 없이 클릭 순회하게 합니다.
5. **우측 `문서 목차` 심볼 표시, `Ctrl+T` 심볼 검색 팔레트, Diff/스냅샷 `Ctrl+F`**:
   - 코드 탭·**Diff 탭**·**스냅샷 탭** 활성 시 **우측 사이드바** 상단 **문서 목차**에 현재 파일의 심볼 목록(함수·클래스·메서드·타입·변수 아이콘/배지, **Diff 탭**에서는 추가 `+`·수정 `M` 배지, 상단 빠른 이름 필터)을 표시하고 클릭 시 해당 줄로 이동합니다.
   - `Ctrl+T`(`Cmd+T`)로 여닫는 플로팅 **심볼 검색 팔레트**로 현재 워크스페이스 또는 활성 탭의 Git Ref 시점 전체 심볼 선언부를 온디맨드 검색해 점프합니다.
   - **Diff 탭**과 **스냅샷 탭**에서도 `Ctrl+F`(`Cmd+F`) **문서 내 찾기 바**를 지원해 대소문자·전체 단어·정규식 일치 강조 및 `Enter`/`Shift+Enter` 순환 스크롤을 제공합니다.

## User Stories (사용자 스토리)

1. As a 개발자, I want 비마크다운 코드 문서를 `Raw` **에디터 모드**로 열었을 때 파일 확장자에 맞는 신택스 하이라이팅이 적용되기를 원하며, so that 별도의 에디터를 켜지 않고도 코드 파일을 가독성 있게 읽고 탐색할 수 있습니다.
2. As a 개발자, I want 코드 탭·**Diff 탭**·**스냅샷 탭**을 열었을 때 **우측 사이드바** 상단 **문서 목차**에서 현재 파일의 함수·클래스·변수 심볼 목록(**Diff 탭**의 추가 `+`·수정 `M` 변경 배지 및 이름 필터 포함)을 보고 클릭해 즉시 해당 줄로 이동하기를 원하며, so that 긴 코드 파일이나 Diff에서도 구조와 변경 심볼을 빠르게 훑을 수 있습니다.
3. As a 개발자, I want **Diff 뷰어**·**스냅샷 뷰어**·일반 코드 `Raw` 탭에서 심볼을 `Ctrl+클릭`(`Cmd+클릭`)해 정의(선언부)로 바로 점프하기를 원하며, so that 호출 흐름을 따라가며 코드 변경의 원인과 영향을 분석할 수 있습니다.
4. As a 개발자, I want 과거 커밋·**Compare 뷰**·Stash의 **Diff 뷰어**에서 `Ctrl+클릭`으로 이동할 때 변경 Hunk 안의 대상이면 **Diff 탭**으로 이동하고, Hunk 밖이거나 미변경 파일이면 `🔒 <ref>` 배지와 상단 읽기 전용 안내 띠가 있는 **스냅샷 탭**(`[로컬 파일 열기]` 버튼 포함)으로 열리기를 원하며, so that 현재 내 로컬 편집 파일과 과거 시점 코드를 절대 혼동하지 않고 정확한 줄 번호를 추적할 수 있습니다.
5. As a 개발자, I want `Ctrl+클릭` 시 동명이인 선언 후보가 여럿이면 커서 근처 선택 팝오버에서 고르고, 저장소 내에 명확한 선언부가 없지만 다른 참조가 있으면 **우측 사이드바** **레퍼런스 섹션**으로 자동 연결되어 안내받기를 원하며, so that 경량 분석 환경에서도 탐색 흐름이 막히지 않습니다.
6. As a 개발자, I want 코드·**Diff 뷰어**·**스냅샷 뷰어**에서 우클릭 `'레퍼런스 찾기'` 또는 `Shift+F12`를 실행하면 **우측 사이드바** 하단 **레퍼런스 섹션**이 자동으로 열려 시점 일치 참조 목록(현재 Diff/Compare 변경 파일 우선)을 표시하고, 목록이 닫히지 않은 채 여러 호출부를 차례로 클릭해 이동하기를 원하며, so that **왼쪽 사이드바**의 **Git 뷰**·**Compare 뷰**를 가리지 않고 영향 범위를 전수 확인할 수 있습니다.
7. As a 개발자, I want 각 **편집기 영역** 헤더 좌측의 `←`/`→` 버튼과 `Alt+←`/`Alt+→`(또는 마우스 뒤로/앞으로 버튼)로 방금 보던 **Diff 탭**·**스냅샷 탭**·코드 줄로 단계별 복귀·전진하기를 원하며, so that 여러 파일을 깊게 타고 들어갔다가도 원래 리뷰하던 위치로 즉시 돌아올 수 있습니다.
8. As a 개발자, I want `Ctrl+T`(`Cmd+T`)로 **심볼 검색 팔레트**를 열어 현재 워크스페이스 또는 활성 **Diff 탭**·**스냅샷 탭**의 Git Ref 시점 전체에서 함수·클래스·변수 선언부를 이름으로 빠르게 검색해 점프하기를 원하며, so that 파일 경로를 모르더라도 원하는 심볼로 바로 이동할 수 있습니다.
9. As a 개발자, I want **Diff 탭**과 **스냅샷 탭**에서도 `Ctrl+F`(`Cmd+F`)로 **문서 내 찾기 바**를 열어 대소문자·전체 단어·정규식 옵션을 바꿔가며 일치 위치를 강조하고 `Enter`/`Shift+Enter`로 순환하기를 원하며, so that 긴 Diff나 스냅샷 파일 내에서도 특정 텍스트를 놓치지 않고 찾을 수 있습니다.
10. As a 위키 작성자, I want 마크다운 문서의 기존 편집·목차·속성·링크 이동 동작과 **메인 창**·**보조 창** 분리 및 워크스페이스 전환 격리가 그대로 유지되기를 원하며, so that 평소 위키 작업 시 어떤 성능 저하나 UI 혼란도 겪지 않습니다.

## Implementation Decisions (구현 결정사항)

### 1. 핵심 도메인·상태 스키마 계약 (`symbol-nav-prototype.html` 프로토타입 안 B 및 기존 IPC 패턴 기반 확정)

```ts
export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'property'

export interface DocumentSymbolItem {
  name: string
  kind: SymbolKind
  lineNumber: number
  columnStart: number
  columnEnd: number
  containerName?: string
  diffChange?: 'added' | 'modified'
}

export type CodeSourceScope =
  | { kind: 'working-tree' }
  | { kind: 'git-ref'; ref: string; displayRef: string; untrackedParentRef?: string }
  | { kind: 'git-index'; displayRef: string }

export interface GitBlobSnapshotRequest {
  path: string
  scope: Exclude<CodeSourceScope, { kind: 'working-tree' }>
  stashHash?: string
}

export interface GitBlobSnapshot {
  path: string
  scope: Exclude<CodeSourceScope, { kind: 'working-tree' }>
  isBinary: boolean
  isTruncated: boolean
  existsInWorkspace: boolean
  encoding: TextEncoding
  content: string
}

export interface SymbolQueryRequest {
  symbolName?: string
  declarationQuery?: string
  scope: CodeSourceScope
  maxResults?: number
}

export interface SymbolCandidateMatch {
  path: string
  lineNumber: number
  lineText: string
  columnStart: number
  columnEnd: number
}

export interface SnapshotTabState {
  request: GitBlobSnapshotRequest
  isPreview?: boolean
  scrollTop: number
}

export type TabItem = DocumentTabItem | DiffTabItem | SnapshotTabItem
```

- **탐색 히스토리(Navigation History) 상태 머신**:
  - 각 **편집기 영역**(`PaneId`)은 독립적인 `backStack: PaneNavigationEntry[]`와 `forwardStack: PaneNavigationEntry[]`(최대 상한 예: 50건)을 가집니다.
  - 심볼 정의 이동·레퍼런스 항목 점프·**심볼 검색 팔레트** 점프 시 출발 위치(활성 탭 식별자, 줄 번호, 컬럼)를 `backStack`에 push하고 `forwardStack`을 비웁니다.
  - `goBack` 실행 시 현재 위치를 `forwardStack`에 push하고 `backStack` 최상단 위치로 복원·점프하며, `goForward`는 역방향으로 동작합니다. 워크스페이스 전환 시 두 스택을 모두 초기화합니다.

### 2. 온디맨드 경량 분석 및 번들 경계 불변식

- **런타임 의존성 제한**: `package.json`의 `dependencies`는 기존 `node-pty` 단독 구성을 유지합니다(신규 외부 패키지 설치 없음).
- **메인/렌더러 파서 분리**: 메인 프로세스는 무거운 `@codemirror/lang-*` 파서 번들을 import하지 않고 `git grep -n -w -I` / 선언부 후보 정규식 프리필터 / `git show` 및 기존 텍스트 파일 스캐너만 실행하며, 정확한 Lezer 구문 트리 파싱(커서 위치 식별자 판별·주석/문자열 제외·AST 선언부 검증·파일 내 심볼 추출)은 렌더러의 지연 로드 파서 계층에서 수행합니다.
- **리소스·성능 가드**: 모든 스캔·Git 조회는 Single-flight 취소(`AbortSignal` 및 하위 프로세스 종료), 바이너리 제외, 파일당 `2MB` 상한, 결과 개수 상한, `.git`·`.wiki-editor`·`node_modules` 제외를 적용합니다.
- **인코딩 일치성**: Git 블롭 스냅샷과 워킹트리 텍스트 조회는 기존 정책과 동일하게 엄격 UTF-8 검증 후 EUC-KR(CP949) 자동 감지 폴백을 적용합니다.

### 3. 시점 해석, 우선순위 랭킹 및 UI 전환 규칙

- **Diff 뷰어 클릭 시점 매핑**:
  - `unstaged`: 삭제(`old`) 줄은 `{ kind: 'git-ref', ref: 'HEAD', displayRef: 'HEAD' }`, 추가/문맥(`new`) 줄은 `{ kind: 'working-tree' }`.
  - `staged`: 삭제 줄은 `HEAD`, 추가/문맥 줄은 `{ kind: 'git-index', displayRef: 'Staged' }`.
  - `commit`: 삭제 줄은 `<commitHash>^1`(루트 커밋 등 부모 부재 시 빈 결과 안전 폴백), 추가/문맥 줄은 `<commitHash>`.
  - `stash`: 삭제 줄은 `<stashHash>^1`, 추가/문맥 줄은 `<stashHash>`(미추적 파일 비교용 `untrackedParentRef: '<stashHash>^3'`).
  - `branch-compare`: 삭제 줄은 `mergeBaseHash ?? baseRef`, 추가/문맥 줄은 `compareRef`.
- **정의·레퍼런스 후보 우선순위**:
  `① 현재 파일 내 일치 → ② 현재 활성 Diff/Compare 변경 파일 목록에 포함된 파일(변경 Hunk 내부 우선) → ③ 동일/인접 디렉토리 경로 → ④ 저장소 상대 경로순`으로 정렬합니다.
- **스냅샷 탭 생명주기**:
  - **스냅샷 탭**은 **문서 버퍼**·자동 저장·미저장 닫기 확인·`workspace-state.json` 영속 대상에서 제외됩니다.
  - **Diff 탭**과 동일한 Preview + Pin 규칙(단일 점프 시 **편집기 영역**당 최대 1개의 Preview 탭 재사용, 탭 더블클릭 또는 `Shift` 동반 시 고정)을 따르며, 다른 **편집기 영역** 이동·복제·**보조 창** 분리/재병합, Stash `Pop`·`Drop`·`Clear All` 시 해당 `stashHash` 기반 탭 자동 정리 및 워크스페이스 전환 시 일괄 정리를 지원합니다.
- **우측 사이드바 이중 역할 전환**:
  - 마크다운 문서 활성 시 기존 `문서 목차(헤딩) + 문서 속성 섹션`을 그대로 유지합니다.
  - 비마크다운 코드 탭·**Diff 탭**·**스냅샷 탭** 활성 시에만 `문서 목차(코드 심볼 + 필터) + 레퍼런스 섹션`으로 전환합니다.

## Testing Decisions (테스트 결정사항)

- **검증 기준**: 내부 파싱 구현 세부사항이 아니라, 공개 IPC 계약·실제 Git 저장소 동작·사용자 관점 UI 인터랙션(클릭, 단축키, 탭 전환, 사이드바 표시)을 기준으로 검증합니다.
- **사전 합의된 테스트 심(Pre-agreed Seams)**:
  1. **`GitService` + `WorkspaceQueryAndSchemaHub` + IPC 통합 테스트 심** (실제 임시 Git 샌드박스·워크트리·Stash·EUC-KR 환경):
     - *Catches*: Git Ref/인덱스/Stash(`^3` 포함) 시점별 블롭 읽기와 UTF-8/EUC-KR 디코딩, `git grep` 및 비Git/열린 미저장 **문서 버퍼**/미추적 파일 결합 심볼·식별자 검색, Single-flight 취소·용량/바이너리 가드, Ref·경로 인젝션 및 활성 워크스페이스 격리 위반.
     - *Misses*: 렌더러 Lezer AST 판별 세부 동작, 탭 전환·팝오버·사이드바 UI 인터랙션 및 시각 레이아웃.
  2. **`App` + 인메모리 `WikiApi` 하네스 통합 테스트 심** (**메인 창**·**보조 창** 멀티 윈도우 하네스 포함):
     - *Catches*: 비마크다운 `Raw` 신택스 하이라이팅, `Ctrl+클릭` 정의 이동(변경 Hunk 내 **Diff 탭** 점프 vs `🔒 <ref>` **스냅샷 탭** Preview 분리 vs 로컬 편집 탭, 다중 후보 팝오버, 선언 미발견 시 **레퍼런스 섹션** 자동 폴백), 우클릭/`Shift+F12` **레퍼런스 섹션** 클릭 순회, **편집기 영역**별 `←`/`→`(`Alt+←`/`Alt+→`) **탐색 히스토리**, **우측 사이드바** 심볼 **문서 목차**(필터·Diff 변경 배지), `Ctrl+T` **심볼 검색 팔레트**, **Diff 탭**·**스냅샷 탭** `Ctrl+F` 찾기, 마크다운 비침범 및 **보조 창** 호환성.
     - *Misses*: 실제 `git` 하위 프로세스 실행 및 브라우저 픽셀 단위 CSS 스타일링.
  3. **Lezer 심볼 추출기 및 가상 스크롤 `GitDiffViewer` 컴포넌트 테스트 심**:
     - *Catches*: 다중 언어(TS/JS/TSX, Python, C/C++, Go, Rust, Java 등) 구문 트리 기반 선언/참조 구분(주석·문자열 내 동명 단어 오탐 배제 포함), 가상 스크롤이 켜진 대용량 **Diff 뷰어**에서의 원거리 줄 점프·삭제(`old`)/추가(`new`) 줄별 `Ctrl+클릭`·`Ctrl+F` 일치 순환.
     - *Misses*: 메인 프로세스 IPC 통신 및 다중 창 세션 조율.
- **참고할 기존 테스트 패턴(Prior art)**:
  - 임시 Git 샌드박스 기반 diff/compare/stash 통합 테스트 패턴
  - `App` + 인메모리 `WikiApi` 하네스 기반 검색·비교·멀티윈도우 통합 테스트 패턴
  - **Diff 뷰어** 및 **문서 편집기** 점프/찾기 컴포넌트 테스트 패턴

## Out of Scope (범위 제외 사항)

- 외부 언어 서버(LSP: `tsserver`, `pyright`, `clangd` 등) 프로세스 실행 및 크로스 파일 정적 타입 추론·인터페이스 구현체 해석
- 워크스페이스 열기 시점의 백그라운드 전체 심볼 사전 인덱싱 또는 디스크 영속 심볼 DB
- `node_modules`·외부 SDK·패키지 내부 선언부 추적
- 심볼 이름 일괄 변경(Rename Symbol) 등 코드 리팩토링 편집 기능
- 마크다운 문서 본문 또는 마크다운 코드 블록 내부에서의 코드 심볼 `Ctrl+클릭` 점프

## Further Notes (기타 참고사항)

- 확정된 UI 레퍼런스: 대화 중 승인된 `symbol-nav-prototype.html` 인터랙티브 프로토타입의 **안 B (`🔒 <ref>` 스냅샷 전용 탭 분리 + 바뀐 줄 안이면 **Diff 탭** 이동 + **에디터 헤더** `←`/`→` 탐색 히스토리)**.
- 구현 마무리 단계에서 도메인 용어집(`CONTEXT.md`)과 사용자 매뉴얼(`docs/manual.md`)을 함께 갱신합니다.
