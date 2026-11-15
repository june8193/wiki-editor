# Spec: Git 패널 Changes · Graph 분할 및 읽기 전용 Diff 뷰어

## Problem Statement (문제 정의)

현재 **왼쪽 사이드바**의 **Git 뷰**에 표시되는 **Git 패널**은 워킹 트리의 스테이징·커밋·브랜치 전환·원격 동기화 기능만 단일 스크롤 영역으로 제공하고 있어 다음 한계가 있습니다.

- 저장소의 커밋 히스토리, 브랜치 분기·병합 흐름, 원격 추적 브랜치(`origin/...`) 및 태그 대비 현재 `HEAD`의 위치를 시각적으로 파악할 수 없습니다.
- 특정 커밋에서 어떤 메시지와 파일 변경이 있었는지 앱 안에서 확인할 방법이 없습니다.
- **Git 패널**의 스테이징/변경 파일이나 과거 커밋의 변경 파일을 클릭해도 변경 전·후 차이를 비교할 수 있는 뷰가 없어 외부 Git 도구나 터미널을 함께 열어야 합니다.
- 기존 **Git 패널** 최상단 헤더에 남아 있는 패널 전체 접기 토글은 **액티비티 바**의 사이드바 접기 동작과 중복됩니다.

## Solution (해결 방안)

VS Code의 Source Control 뷰와 동일한 경험으로 **Git 패널**을 개편하고, 중앙 **편집 공간**에 읽기 전용 **Diff 탭**을 도입합니다.

1. **상단 고정 공통 영역 + 상하 분할 아코디언(`Changes 섹션` / `Graph 섹션`)**:
   - **Git 패널** 최상단에는 고정 타이틀 헤더(`Git`, 현재 브랜치 배지, `↑ahead ↓behind` 배지, `↻` 새로고침 버튼)와 저장소 공통 제어(브랜치 선택·전환, `Pull` / `Push` / `Sync`)를 상시 배치하여, **Changes 섹션**을 접고 **Graph 섹션**만 볼 때도 브랜치 전환과 원격 동기화를 수행할 수 있게 합니다.
   - 그 아래 영역을 상단 **Changes 섹션**(커밋 입력폼 + 스테이지됨/변경 사항 목록)과 하단 **Graph 섹션**(커밋 그래프 히스토리) 두 개의 접기/펼치기 가능한 아코디언으로 나누고, 둘 다 펼쳐져 있을 때는 중간 **섹션 리사이저**로 높이 비율을 조절합니다.
2. **시각적 커밋 그래프 및 인라인 커밋 상세 트리**:
   - **Graph 섹션** 헤더에서 `전체`(모든 로컬·원격 추적 브랜치 및 태그, 기본값)와 `현재 브랜치`(`HEAD` 및 연결된 upstream) 범위를 전환할 수 있습니다.
   - 각 커밋 행에 컬러 SVG 레인(분기·병합 선, 일반/머지 노드, `HEAD` 강조 링), 참조 배지(`HEAD`, 로컬 브랜치, 원격 브랜치, 태그), 커밋 제목·작성자를 표시하고 페이지네이션(`더 보기`)을 지원합니다.
   - 커밋 행을 클릭하면 바로 아래에 전체 메시지·작성자·일시·단축 해시(**해시 복사** 버튼 포함)와 변경된 파일 목록(`A` / `M` / `D` / `R`)을 인라인으로 펼쳐 보여줍니다(조회 전용).
3. **중앙 편집 공간의 읽기 전용 Diff 탭 (`Changes` · `Graph` 공통)**:
   - **Changes 섹션**의 변경 파일 또는 **Graph 섹션**의 확장된 커밋 내 파일을 클릭하면 활성 **편집기 영역**에 읽기 전용 **Diff 탭**을 열어 변경 전·후 내용을 비교합니다.
   - 기본 **좌우 비교(Side-by-Side)** 뷰와 **인라인(Unified)** 뷰 전환 토글, 현재 워크스페이스에 존재하는 파일을 실제 편집 문서로 여는 **`파일 열기`** 버튼을 제공합니다.
   - 연속 탐색 시 탭이 무한히 쌓이지 않도록 활성 **편집기 영역**에 이미 열려 있는 **Diff 탭**을 교체 재사용하되, 다른 분할 영역으로 옮겨 둔 **Diff 탭**은 그대로 유지합니다.

## User Stories (사용자 스토리)

1. As a 위키 작성자, I want **Git 패널** 상단에 브랜치 전환과 `Pull`/`Push`/`Sync` 및 새로고침이 고정되고 그 아래가 **Changes 섹션**과 **Graph 섹션**으로 나뉘어 표시되기를 원하며, so that 현재 변경 작업과 커밋 히스토리를 한 화면에서 동시에 파악할 수 있습니다.
2. As a 위키 작성자, I want **Changes 섹션**과 **Graph 섹션**을 각각 헤더 클릭으로 접거나 펼치고, 둘 다 펼쳐져 있을 때 중간 **섹션 리사이저**를 드래그하거나 상·하 방향키·더블클릭으로 높이 비율을 조절하기를 원하며, so that 작업 맥락에 맞춰 원하는 섹션에 세로 공간을 집중할 수 있습니다.
3. As a 위키 작성자, I want **Changes 섹션**을 접은 상태에서도 상단 고정 영역에서 브랜치를 전환하거나 `Pull`/`Push`/`Sync`를 실행할 수 있기를 원하며, so that **Graph 섹션**을 넓게 보면서 브랜치 이동과 동기화 결과를 즉시 확인할 수 있습니다.
4. As a 위키 작성자, I want 워크스페이스가 열리지 않았거나 Git 저장소가 아닐 때는 분할 섹션 대신 기존의 안내 문구와 `Git 저장소 초기화 (git init)` 버튼만 표시되기를 원하며, so that 비저장소 상태에서도 혼란 없이 저장소를 초기화할 수 있습니다.
5. As a 위키 작성자, I want **Graph 섹션**에서 각 커밋의 부모-자식 분기·병합 흐름이 컬러 SVG 레인과 노드(`HEAD` 강조 포함), 참조 배지(`HEAD`, 로컬 브랜치, `origin/...`, 태그), 커밋 제목·작성자로 표시되기를 원하며, so that 브랜치 구조와 원격 대비 상태를 한눈에 이해할 수 있습니다.
6. As a 위키 작성자, I want **Graph 섹션** 헤더에서 `전체`(모든 로컬·원격 브랜치 및 태그)와 `현재 브랜치`(`HEAD` 및 upstream) 필터를 전환할 수 있기를 원하며, so that 전체 분기 흐름 확인과 현재 브랜치 집중 조회를 필요에 따라 오갈 수 있습니다.
7. As a 위키 작성자, I want 커밋이 많을 때 초기 100개를 빠르게 불러오고 목록 하단의 `더 보기` 버튼으로 이전 커밋을 추가 로드하기를 원하며, 첫 커밋 전(`isUnborn`) 저장소에서는 빈 상태 안내를 보기를 원하며, so that 대형 저장소와 신규 저장소 모두에서 끊김 없이 동작합니다.
8. As a 위키 작성자, I want Commit, Pull, Push, Sync, 브랜치 전환, 수동 새로고침, 워크스페이스 파일 변경 감지 시 **Graph 섹션**도 자동으로 최신 히스토리를 반영하기를 원하며, so that 별도 조작 없이 항상 최신 그래프를 볼 수 있습니다.
9. As a 위키 작성자, I want **Graph 섹션**에서 커밋 행을 클릭하면 바로 아래에 작성자·일시·전체 메시지·단축 해시(`해시 복사` 버튼 포함)와 변경 파일 목록(`A`/`M`/`D`/`R` 및 이름 변경 경로)이 펼쳐지고 다시 클릭하면 접히기를 원하며, so that 에디터 화면을 가리지 않고도 커밋 변경 내역을 빠르게 훑어볼 수 있습니다.
10. As a 위키 작성자, I want 머지 커밋이나 초기(루트) 커밋을 펼쳤을 때도 해당 커밋이 도입한 변경 파일 목록이 빈 목록 없이 정확히 표시되기를 원하며, so that 병합 이력과 최초 커밋의 변경 파일도 빠짐없이 확인할 수 있습니다.
11. As a 위키 작성자, I want **Changes 섹션**의 `스테이지됨`·`변경 사항`(Untracked `?` 포함) 파일이나 **Graph 섹션**의 커밋 내 변경 파일을 클릭하면 활성 **편집기 영역**에 읽기 전용 **Diff 탭**이 열리기를 원하며(`+`/`-` 스테이징 버튼 클릭 시에는 열리지 않음), so that 커밋 전 변경 검토와 과거 커밋 코드 비교를 동일한 방식으로 수행할 수 있습니다.
12. As a 위키 작성자, I want **Diff 탭**이 기본적으로 좌우 비교(Side-by-Side) 뷰로 열리고 헤더에서 인라인(Unified) 뷰로 전환할 수 있으며, 현재 워크스페이스에 존재하는 파일이면 `파일 열기` 버튼으로 즉시 편집 가능한 일반 문서 탭을 열 수 있기를 원하며, so that 변경 확인에서 문서 편집으로 자연스럽게 이어갈 수 있습니다.
13. As a 위키 작성자, I want 여러 변경 파일과 커밋 파일을 연속으로 클릭할 때 활성 **편집기 영역**의 기존 **Diff 탭**이 교체되어 탭이 무한정 쌓이지 않고, 다른 분할 영역으로 옮겨 둔 **Diff 탭**은 그대로 유지되기를 원하며, so that **탭 바**를 깔끔하게 유지하면서도 필요 시 두 개의 Diff나 문서와 Diff를 나란히 비교할 수 있습니다.
14. As a 위키 작성자, I want **Changes 섹션**에서 연 Working/Staged **Diff 탭**이 파일 저장·Stage·Unstage·Commit 시 자동으로 최신 변경 상태를 반영하고 워크스페이스를 전환하면 함께 닫히기를 원하며, so that 오래된 Diff 내용을 보고 착각하지 않습니다.

## Implementation Decisions (구현 결정사항)

### 1. Git 패널 레이아웃 및 세션 상태 계약
- **바깥 영역 접근성 유지**: **Git 패널** 최상위 영역의 기존 접근 가능한 이름(`aria-label="Git 소스 제어"`)은 그대로 유지하고, 최상단 헤더에 있던 패널 전체 접기 토글만 제거하여 고정 헤더(`Git` 타이틀, 브랜치 배지, `↑ahead ↓behind` 배지, `↻` 새로고침)로 단순화합니다.
- **상단 고정 공통 영역**: `status.isRepo === true`일 때 진행 상태 배너, 오류 알림 배너, 브랜치 선택 드롭다운 + `전환` 버튼, `Pull` / `Push` / `Sync` 버튼을 아코디언 위쪽 고정 영역에 배치합니다.
- **상하 분할 아코디언 상태 모델** (세션 메모리 전용, `config.json`에 저장하지 않음):

  ```ts
  interface GitPanelSplitState {
    isChangesCollapsed: boolean // 기본값 false
    isGraphCollapsed: boolean // 기본값 false
    changesHeightRatio: number // clamp(ratio, 0.2, 0.8), 기본값 0.5
  }
  ```

- **섹션 배분 및 섹션 리사이저 규칙**:
  - **Changes 섹션** 헤더는 접기/펼치기 버튼(`aria-expanded`)과 총 변경 파일 수 배지(`staged.length + unstaged.length + untracked.length`)를 표시하며, 본문은 커밋 입력폼과 `스테이지됨`·`변경 사항` 파일 목록을 담고 독립 세로 스크롤됩니다.
  - **Graph 섹션** 헤더는 접기/펼치기 버튼(`aria-expanded`)과 우측 범위 필터 토글(`전체` / `현재 브랜치`, 헤더 접기 버튼과 클릭 영역 분리)을 표시하며, 본문은 독립 세로 스크롤됩니다.
  - 두 섹션이 모두 펼쳐져 있으면 본문 높이를 `changesHeightRatio : (1 - changesHeightRatio)`로 배분하고, 사이에 가로 방향 **섹션 리사이저**(`role="separator"`, `aria-orientation="horizontal"`, `aria-valuenow/min/max` 백분율 `20`~`80`, 포인터 드래그 `row-resize`, 상·하 방향키 조절, 더블클릭 시 `50%` 복원)를 렌더링합니다.
  - 한쪽만 펼쳐져 있으면 **섹션 리사이저**를 숨기고 펼쳐진 섹션 본문이 남은 높이를 100% 차지하며, 다시 펼치면 직전 `changesHeightRatio`를 복원합니다. 둘 다 접혀 있으면 두 섹션 헤더만 상단에 남습니다.

### 2. 커밋 그래프 · 커밋 상세 데이터 스키마 및 조회 계약
- **공유 데이터 타입 형태** (설계 확정 스키마):

  ```ts
  export type GitLogScope = 'all' | 'current'
  export type GitRefKind = 'head' | 'local-branch' | 'remote-branch' | 'tag'

  export interface GitRefBadge {
    name: string
    kind: GitRefKind
    isCurrentHead?: boolean
  }

  export interface GitGraphCommit {
    hash: string
    shortHash: string
    parents: string[]
    subject: string
    authorName: string
    committedAt: string // ISO-8601
    refs: GitRefBadge[]
  }

  export interface GitLogOptions {
    scope?: GitLogScope // 기본값 'all'
    limit?: number // 기본값 100
    skip?: number // 기본값 0
  }

  export interface GitLogResult {
    commits: GitGraphCommit[]
    hasMore: boolean
  }

  export interface GitCommitDetail {
    hash: string
    shortHash: string
    parents: string[]
    subject: string
    body: string
    authorName: string
    authorEmail: string
    committedAt: string // ISO-8601
    files: GitChangedFile[]
  }
  ```

- **히스토리 조회 규칙**:
  - `scope === 'all'`: 로컬 브랜치(`refs/heads`), 원격 추적 브랜치(`refs/remotes`), 태그(`refs/tags`)의 도달 가능 커밋을 `--topo-order`로 조회하며 `refs/stash` 등 내부 참조와 중복 원격 상징 참조(`*/HEAD`) 배지는 제외합니다.
  - `scope === 'current'`: `HEAD` 및 현재 브랜치에 연결된 upstream(`@{upstream}`이 존재할 때 함께 포함)의 도달 가능 커밋을 `--topo-order`로 조회합니다.
  - 첫 커밋 전(`isUnborn`) 저장소는 예외 대신 `{ commits: [], hasMore: false }`를 반환하고 UI에 `"아직 커밋된 내역이 없습니다."` 안내를 표시합니다.
  - `limit + 1`개 조회 방식으로 추가 페이지(`hasMore`) 유무를 판별하며, 워크스페이스 전환이나 필터 변경 중 도착한 이전 비동기 응답은 요청 시퀀스/에포크 검증으로 무시합니다.
- **순수 레인 배치 알고리즘**:
  - 외부 그래프 라이브러리를 추가하지 않고 `readonly GitGraphCommit[]`로부터 각 행의 활성 레인 배열, 현재 커밋 노드 열, 부모로 이어지는 직선·분기·병합 연결 세그먼트, 순환 팔레트 색상 인덱스, `HEAD` 및 머지 커밋 여부를 계산하는 순수 모듈로 분리합니다.
  - 페이지 경계 바깥에 부모가 있는 커밋의 열린 레인도 하단으로 자연스럽게 이어지게 계산합니다.
- **커밋 상세 및 변경 파일 산출 규칙**:
  - 전달받은 커밋 해시는 16진수 해시 형식(`7~64`자, 선행 `-` 차단)을 검증한 뒤 실행합니다.
  - 초기(루트) 커밋(`parents.length === 0`)은 `--root`(빈 트리 대비)로 비교해 모든 파일을 `A`로 반환하고, 머지 커밋(`parents.length >= 2`)은 첫 번째 부모(`--first-parent` / `<hash>^1`)와 비교(`-M` 이름 변경 감지 포함)하여 병합 변경 파일 목록이 비지 않도록 합니다.
  - 인라인 상세 영역은 조회 전용으로 유지하며 `해시 복사` 버튼 클릭 시 전체 커밋 해시를 클립보드에 복사합니다.

### 3. 읽기 전용 Diff 데이터 계약 및 중앙 편집 공간 통합
- **Diff 요청·응답 스키마** (설계 확정 스키마):

  ```ts
  export type GitDiffRequest =
    | { kind: 'staged'; path: string; origPath?: string; status: GitFileStatusCode }
    | { kind: 'unstaged'; path: string; origPath?: string; status: GitFileStatusCode }
    | {
        kind: 'commit'
        commitHash: string
        shortHash: string
        path: string
        origPath?: string
        status: GitFileStatusCode
      }

  export interface GitFileDiff {
    path: string
    origPath?: string
    status: GitFileStatusCode
    isBinary: boolean
    isTruncated: boolean
    existsInWorkspace: boolean
    rawPatch: string
  }
  ```

- **Git Diff 산출 및 경로 보안 규칙**:
  - 모든 대상 경로(`path`, `origPath`)는 저장소 루트 내부 여부 및 `.git` 세그먼트 차단 검증을 거칩니다. 과거 커밋에서 삭제된 파일·디렉터리 경로도 가장 가까운 현존 상위 디렉터리 실경로 검증을 통해 안전하게 허용하며, 현재 디스크 상에 해당 파일이 존재하는지 여부를 `existsInWorkspace`로 함께 반환합니다.
  - `staged`: `HEAD`가 있으면 `HEAD ↔ Index`, 첫 커밋 전(`isUnborn`)이면 Git 빈 트리(`4b825dc642cb6eb9a060e54bf8d69288fbee4904`) ↔ Index 비교를 수행합니다.
  - `unstaged`: 추적 파일은 `Index ↔ Working Tree` 비교를 수행하고, 미추적(`?`) 파일은 워킹 트리 파일을 안전하게 읽어(NUL 바이트 포함 시 `isBinary: true`, 대용량 임계치 `1MB` 초과 시 `isTruncated: true` 절단) 전체 추가(`+`) 패치로 구성합니다.
  - `commit`: 루트 커밋은 빈 트리 ↔ `<commitHash>`, 일반·머지 커밋은 `<commitHash>^1 ↔ <commitHash>`(`-M` 포함) 비교를 수행합니다.
- **Unified Diff 정렬 및 뷰어 동작**:
  - `rawPatch`를 파싱해 헝크 헤더(`@@ ... @@`), 양쪽 줄 번호, 추가(`+`)/삭제(`-`)/문맥(` `) 줄을 추출하고, 연속된 삭제 블록과 추가 블록을 쌍으로 맞춘 **좌우 비교(Side-by-Side, 기본값)** 행 모델과 **인라인(Unified)** 행 모델을 생성하는 순수 모듈을 둡니다(세션 내 뷰 모드 토글 지원).
  - 바이너리 파일은 `"바이너리 파일은 Diff 미리보기를 지원하지 않습니다."`, 텍스트 변경이 없는 경우 `"표시할 텍스트 변경 사항이 없습니다."`, 대용량 절단 시 절단 안내 배너를 표시합니다.
  - 헤더에는 파일명과 비교 맥락 라벨(`Staged`, `Working Tree`, 또는 단축 커밋 해시), 좌우/인라인 전환 토글, **`파일 열기`** 버튼(`existsInWorkspace === true`일 때 활성화, 클릭 시 해당 워크스페이스 문서 탭 열기/포커스)을 배치합니다.
- **편집기 영역 탭 수명주기 및 격리 규칙**:
  - 활성 **편집기 영역**(`activePaneId`)에서 변경 파일을 클릭했을 때 해당 영역에 이미 **Diff 탭**이 열려 있으면 새 탭을 추가하지 않고 기존 **Diff 탭**의 대상을 교체·활성화합니다. 다른 분할 영역(`primary` 또는 `secondary`)에 열려 있는 **Diff 탭**은 그대로 유지되며, **Diff 탭**도 일반 탭과 동일하게 분할 드래그·영역 간 이동·닫기가 가능합니다.
  - 읽기 전용 **Diff 탭**은 자동 저장(`autoSave`), 미저장 닫기 **확인 다이얼로그**, `Ctrl+S` 및 **에디터 모드** 전환 단축키(`Ctrl+1/2/3`, `Ctrl+Shift+M`), 우측 **문서 목차** 파싱 대상에서 제외됩니다(**Diff 탭** 활성 시 우측 **문서 목차**는 비마크다운 탭과 동일하게 빈 상태 안내를 유지).
  - 워크스페이스 전환 시 기존 워크스페이스 문서 탭들과 함께 모든 **Diff 탭**을 닫습니다.
  - Git 상태가 갱신(Stage/Unstage/Commit/Pull/Sync/브랜치 전환/문서 저장/외부 변경)될 때 현재 열려 있는 `staged`·`unstaged` **Diff 탭**의 내용을 자동으로 재조회하여 동기화합니다.
- **도메인 용어 동기화**: 각 티켓은 자신이 도입·변경한 영역에 맞춰 `CONTEXT.md`의 **Git 패널** 정의를 갱신하고 **Changes 섹션**, **Graph 섹션**, **섹션 리사이저**, **Diff 탭**(**Diff 뷰어**) 용어를 추가합니다.

## Testing Decisions (테스트 결정사항)

- **검증 기준**: 내부 상태나 마크업 구조가 아니라 접근 가능한 역할·이름(`getByRole`, `getByLabelText`) 및 공개 서비스 계약을 통해 사용자가 관찰하는 E2E 동작을 검증합니다. 모든 테스트는 임시 디렉터리 또는 인메모리 하네스로 격리하며 실제 사용자 데이터나 `config.json`을 건드리지 않습니다.
- **사전 합의된 테스트 심 (Pre-agreed Seams)**:
  1. **`<App />` + 인메모리 `window.wikiApi` 통합 심 (React Testing Library)**:
     - **Catches**: **Git 패널** 상단 공통 컨트롤 고정 및 **Changes 섹션**·**Graph 섹션** 접기/펼치기·**섹션 리사이저** 키보드/더블클릭 조절, `전체`/`현재 브랜치` 그래프 필터 전환과 `더 보기` 누적 로드, 커밋 클릭 시 인라인 상세·파일 트리 펼침 및 해시 복사, **Changes 섹션**·**Graph 섹션** 파일 클릭 시 활성 **편집기 영역**의 읽기 전용 **Diff 탭** 열기·교체 재사용·분할 영역 유지·좌우/인라인 전환·`파일 열기` 이동·워크스페이스 전환 정리·Working/Staged Diff 자동 동기화 회귀.
     - **Misses**: 실제 Git CLI 서브프로세스 실행 및 포인터 드래그 픽셀 좌표·SVG 곡선 시각적 렌더링.
  2. **Git 서비스 통합 심 (임시 디렉터리 기반 격리 Git 저장소 테스트)**:
     - **Catches**: 실제 Git CLI 기반 커밋 그래프 조회(`전체` 로컬·원격·태그 및 `현재 브랜치`+upstream 필터, 첫 커밋 전 `isUnborn` 빈 결과, `hasMore` 페이지네이션), 일반·머지(`--first-parent`)·루트(`--root`)·이름 변경(`-M`) 커밋 상세 및 파일 목록 산출 오류, Staged(미커밋 초기 저장소 포함)·Unstaged(Untracked `?` 포함)·특정 커밋 시점 Diff 생성 및 바이너리 감지·과거 삭제 경로 보안 검증 오류.
     - **Misses**: Electron IPC 채널 등록과 렌더러 컴포넌트 상태 전이.
  3. **IPC 핸들러 & Preload 브리지 경계 심 (Vitest 단위 테스트)**:
     - **Catches**: 신규 Git 채널(`git:log`, `git:commit-detail`, `git:diff`)의 활성 워크스페이스 일치 검증·라우팅 누락 및 `window.wikiApi.git` 브리지 인자 매핑 불일치.
     - **Misses**: Git CLI 출력 파싱 세부 로직과 UI 상호작용.
  4. **그래프 레인 배치 · 섹션 비율 제한 · Unified Diff 정렬 순수 함수 심 (Vitest 단위 테스트)**:
     - **Catches**: 선형·분기·병합·다중 부모·페이지 경계 밖 열린 부모 레인의 열 배정 및 연결 패스 오류, **Changes 섹션** 높이 비율 제한(`20%~80%`) 및 기본값(`50%`) 복원 오류, Unified Diff 헝크 파싱 및 좌우 비교(Side-by-Side)/인라인 행 짝맞춤 오류.
     - **Misses**: DOM 이벤트 연결과 스타일링.
- *(위 심 목록은 `/ticket-runner`의 사전 합의된 심(Pre-agreed Seams)으로 사용됩니다.)*
- **참고할 기존 테스트 패턴 (Prior Art)**:
  - `<App />` 통합 테스트의 인메모리 `createInMemoryWikiApi` 하네스 패턴
  - 격리된 임시 저장소(`mkdtemp` + 로컬 `.gitconfig`)에서 실제 `git` 바이너리를 검증하는 Git 서비스 통합 테스트 패턴
  - 사이드바 너비 제한 및 **편집기 영역** 탭 스토어 분할 비율·탭 전이 단위 테스트 패턴
  - 가짜 `IpcMainLike` / `IpcRendererLike` 기반의 IPC 및 Preload 브리지 단위 테스트 패턴

## Out of Scope (범위 제외 사항)

- **Graph 섹션**에서 특정 커밋 체크아웃, 새 브랜치/태그 생성, Reset, Revert, Cherry-pick, Rebase, Stash 등 히스토리·워킹트리를 변경하는 액션
- **Graph 섹션**에 미커밋 변경 사항(Uncommitted Changes) 가상 노드를 중복 표시하는 기능 (상단 **Changes 섹션**이 담당)
- **Diff 탭** 내부에서의 직접 텍스트 편집, 줄/헝크 단위 부분 Stage/Unstage/Discard(인라인 패치 적용)
- 아코디언 접힘 여부, 섹션 높이 비율, 그래프 필터, Diff 뷰 모드(`Side-by-Side` / `Inline`)의 `config.json` 영속화
- 커밋 메시지·작성자 텍스트 검색 필터 UI

## Further Notes (기타 참고사항)

- **대용량·성능 보호**: Diff 패치 응답은 최대 크기(`1MB`)를 넘을 경우 안전하게 절단(`isTruncated: true`)하여 과도한 메모리 점유와 렌더러 프리징을 방지하며, IPC 로깅 시에도 패치 원문 전체가 로그 파일에 남지 않도록 주의합니다.
- **드래그 중 상호작용**: **섹션 리사이저** 드래그 중에는 텍스트 선택을 막고 커서를 `row-resize`로 고정합니다.
