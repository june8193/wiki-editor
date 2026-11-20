# Spec: Git 패널 수동 Stash 관리 (Git Stash Management)

## Problem Statement (문제 정의)

현재 **왼쪽 사이드바**의 **Git 뷰**에 위치한 **Git 패널**은 변경 파일을 스테이지(`+`)하거나 커밋·동기화(`Pull`/`Push`/`Sync`)·롤백(`↶`)하는 기능만 제공하며, 작업 중인 변경 사항을 임시 보관(Stash)하고 다시 꺼내는 기능을 제공하지 않습니다.

- 위키 작성자는 여러 초안 문서를 커밋하지 않은 채 **Changes 섹션**의 `Changes`에 두고 작업하다가, 그중 작성이 끝난 1개 문서만 `Staged Changes`에 올려 커밋·동기화(`Pull`/`Sync`/`Commit & Sync`)하려는 경우가 많습니다.
- 이때 `Changes`에 남아 있는 다른 미커밋 문서 때문에(특히 `pull.rebase = true` 설정이거나 원격 커밋과 수정 파일이 겹칠 때) Git이 작업을 거부해 커밋·푸시 흐름이 막힙니다.
- 앱 안에서 Stash 생성·조회를 할 수 없어 외부 터미널에서 `git stash`를 직접 실행해야 하며, 이 경우 앱 내 미저장(`●`) **문서 버퍼**, **폴더 트리**, 열려 있는 **Diff 탭**과의 동기화를 사용자가 수동으로 챙겨야 합니다.

## Solution (해결 방안)

백그라운드 Auto-Stash로 상태를 몰래 바꾸는 대신, **사용자가 모든 Git 상태 변화를 직접 제어하는 수동 Stash 관리 UI**를 **Git 패널**에 추가합니다.

1. **`Changes 섹션`과 `Graph 섹션` 사이에 `Stashes 섹션` 상시 배치 (B안)**:
   - **Git 패널**의 **Changes 섹션**과 **Graph 섹션** 사이에 **Stashes 섹션**을 항상 렌더링합니다.
   - Stash가 `0`건일 때는 기본 접힘 상태로 헤더만 유지해 세로 공간을 최소화하고, Stash를 생성하면 자동으로 펼칩니다. 본문은 콘텐츠 맞춤 컴팩트 높이(최대 약 `180px` 내부 스크롤, 양쪽 섹션이 모두 접혔을 때만 남은 공간 확장)를 사용하며, **Changes 섹션**과 **Graph 섹션** 사이의 기존 단일 **섹션 리사이저**(`20%~80%`)를 그대로 유지합니다.
2. **원클릭 빠른 보관 + 선택적 메시지 입력 다이얼로그**:
   - `Changes` 하위 그룹 헤더의 Stash 아이콘(`Changes`만 보관 · `Staged Changes` 유지)과 `Changes` 개별 파일 행 호버 액션의 Stash 아이콘(단일 파일 보관)은 별도 입력 없이 **원클릭 즉시 보관**(미추적 `?` 새 문서 포함, 기본 메시지)을 수행합니다.
   - **Stashes 섹션** 헤더의 `+` 버튼과 **Git 패널** 헤더 `...` 더 보기 메뉴(`Stash Changes...`, `Stash All Changes...`)에서는 가벼운 Stash 입력 다이얼로그를 열어 선택적 메시지(빈 값 허용), 보관 범위(`Changes만 보관 (Staged 유지)` / `전체 보관 (Staged 포함)`), `미추적 파일(?) 포함`(기본 켜짐)을 지정할 수 있습니다.
3. **인라인 변경 파일 목록 및 읽기 전용 `Diff 탭` 미리보기**:
   - **Graph 섹션** 커밋 상세와 동일한 UX로, Stash 항목 행을 클릭하면 해당 Stash에 보관된 변경 파일 목록(추적 변경 `M`/`A`/`D`/`R` 및 3번째 부모에 보관된 미추적 `?` 새 문서 포함)을 인라인으로 펼칩니다.
   - 펼쳐진 파일 행을 클릭하면 활성 **편집기 영역**에 읽기 전용 **Diff 탭**(**Diff 뷰어**)을 열어 **좌우 비교(Side-by-Side)** / **인라인(Inline)** 전환 및 `파일 열기`로 내용을 미리볼 수 있습니다.
4. **`Pop` / `Apply` 복원, `Drop` / `Clear All` 위험 확인 및 버퍼·탭 완전 동기화**:
   - Stash 행 호버/포커스 액션으로 `Pop`(복원 후 목록에서 제거), `Apply`(복원 후 목록 유지), `Drop`(개별 삭제, 위험 강조 `danger` **확인 다이얼로그**)을 제공하고, **Stashes 섹션** 헤더 및 `...` 메뉴에서 `Clear All`(전체 삭제, `danger` **확인 다이얼로그**)을 제공합니다.
   - 복원은 표준 워킹 트리 복원(`Changes`로 복원)을 따르며 충돌 발생 시 Git 기본 동작대로 해당 Stash를 보존해 작업 유실을 방지합니다.
   - Stash 생성·복원 전 대상/워크스페이스 미저장(`●`) **문서 버퍼**를 기존 `'저장 후 진행'` / `'저장 없이 진행'` **확인 다이얼로그**로 보호하고, 완료 후 **메인 창**·**보조 창**의 열린 **문서 버퍼**, **폴더 트리**, **액티비티 바** 배지, `unstaged`·무효 `stash` **Diff 탭**을 즉시 동기화합니다.

## User Stories (사용자 스토리)

1. As a 위키 작성자, I want 완료한 1개 문서를 `Staged Changes`에 올려둔 상태에서 `Changes` 하위 그룹 헤더의 Stash 아이콘을 원클릭해 남은 초안(미추적 `?` 새 문서 포함)만 즉시 보관하고 `Staged Changes`는 그대로 유지하기를 원하며, so that 다른 초안 때문에 막히지 않고 1개 문서만 바로 커밋·동기화할 수 있습니다.
2. As a 위키 작성자, I want `Changes` 목록의 특정 파일 행에 마우스를 올렸을 때만 나타나는 Stash 아이콘으로 해당 파일 1개만 원클릭 즉시 보관하기를 원하며(`Staged Changes` 행에는 미노출), so that 비호버 시 파일명을 가리지 않으면서도 필요한 초안 파일만 골라 빠르게 치울 수 있습니다.
3. As a 위키 작성자, I want **Stashes 섹션** 헤더의 `+` 버튼이나 **Git 패널** `...` 더 보기 메뉴에서 가벼운 Stash 입력 다이얼로그를 열어 선택적 메시지, 보관 범위(`Changes만 보관` / `전체 보관`), `미추적 파일(?) 포함` 여부를 지정해 저장하기를 원하며, so that 오래 보관할 초안 묶음에 알아보기 쉬운 메모를 남길 수 있습니다.
4. As a 위키 작성자, I want **Changes 섹션**과 **Graph 섹션** 사이에 항상 표시되는 **Stashes 섹션**이 `0`건일 때는 기본 접힘 상태로 공간을 절약하고 Stash 생성 시 자동으로 펼쳐지며 컴팩트 최대 높이 스크롤과 기존 **섹션 리사이저**가 함께 동작하기를 원하며, so that 보관한 Stash를 놓치지 않으면서도 **Changes 섹션**·**Graph 섹션** 작업 공간을 잃지 않습니다.
5. As a 위키 작성자, I want Stash 행의 `Pop` 버튼으로 보관한 변경 사항을 `Changes`로 복원하고 목록에서 제거하기를 원하며(충돌 시 Stash가 삭제되지 않고 보존되며 명확한 오류 안내 표시), so that 동기화를 마친 뒤 임시 치워둔 초안을 안전하게 되돌릴 수 있습니다.
6. As a 위키 작성자, I want Stash 행의 `Apply` 버튼으로 Stash 항목을 목록에 남겨둔 채 변경 내용만 `Changes`에 적용하기를 원하며, so that 초안 백업을 유지한 상태로 내용을 다시 꺼내 쓸 수 있습니다.
7. As a 위키 작성자, I want Stash 행의 `Drop` 또는 **Stashes 섹션** 헤더·`...` 메뉴의 `Clear All` 실행 시 위험 강조(`danger`) **확인 다이얼로그**에서 대상과 복구 불가 안내를 확인한 뒤 삭제(취소 시 유지)하기를 원하며, so that 보관된 초안을 실수로 영구 삭제하지 않습니다.
8. As a 위키 작성자, I want Stash 행을 클릭하면 보관된 전체 변경 파일(미추적 `?` 새 문서 포함)이 인라인으로 펼쳐지고, 파일을 클릭하면 활성 **편집기 영역**에 읽기 전용 **Diff 탭**이 열려 **좌우 비교(Side-by-Side)**/**인라인(Inline)** 전환과 `파일 열기`를 사용할 수 있기를 원하며, so that 꺼내기 전에 어떤 초안이 들어 있는지 정확히 확인할 수 있습니다.
9. As a 위키 작성자, I want Stash 생성·`Pop`·`Apply` 대상에 미저장(`●`) **문서 버퍼**가 열려 있을 때 기존 `'저장 후 진행'` / `'저장 없이 진행'` 확인을 거치되 생성 시 비대상 미저장 문서는 간섭하지 않고, 완료 후 **메인 창**·**보조 창**의 **문서 버퍼**(사라진 미추적 문서 탭 자동 닫기 포함)·**폴더 트리**·`unstaged` 및 무효화된 `stash` **Diff 탭**·**액티비티 바** 배지가 즉시 동기화되기를 원하며, so that 에디터 상태와 디스크·Git 상태가 어긋나지 않습니다.
10. As a 위키 작성자, I want 미커밋 로컬 변경 사항 때문에 `Pull`/`Sync`가 차단되었을 때 오류 배너에서 변경 사항을 커밋하거나 Stash로 임시 보관하도록 명확한 안내를 받기를 원하며, so that 막힌 이유를 즉시 이해하고 **Git 패널** 안에서 바로 해결할 수 있습니다.

## Implementation Decisions (구현 결정사항)

### 1. 공유 Stash 데이터 스키마 및 Git API 계약
- **공유 데이터 타입 및 API 확장** (프로토타입 및 기존 Git API 패턴 기반 확정 스키마):

  ```ts
  export type GitStashScope = 'unstaged' | 'all' | 'paths'

  export interface GitStashEntry {
    ref: string // 예: 'stash@{0}'
    hash: string
    branch: string | null
    message: string
    createdAt: string // ISO-8601
  }

  export interface GitStashDetail extends GitStashEntry {
    files: GitChangedFile[]
  }

  export interface GitStashCreateOptions {
    scope: GitStashScope
    message?: string
    includeUntracked?: boolean // 기본값 true
    paths?: string[] // scope === 'paths'일 때 필수
  }

  export type GitDiffRequest =
    | ({ kind: 'staged' } & GitChangedFile)
    | ({ kind: 'unstaged' } & GitChangedFile)
    | ({ kind: 'commit'; commitHash: string; shortHash: string } & GitChangedFile)
    | ({ kind: 'stash'; stashRef: string; stashHash: string } & GitChangedFile)
  ```

- **공유 `WikiGitApi` 메서드 확장** (설계 확정 계약):

  ```ts
  export interface WikiGitApi {
    // 기존 메서드 유지 ...
    stashList: (workspacePath: string) => Promise<GitStashEntry[]>
    stashDetail: (workspacePath: string, stashRef: string) => Promise<GitStashDetail>
    stashCreate: (workspacePath: string, options: GitStashCreateOptions) => Promise<GitStatus>
    stashApply: (workspacePath: string, stashRef: string) => Promise<GitStatus>
    stashPop: (workspacePath: string, stashRef: string) => Promise<GitStatus>
    stashDrop: (workspacePath: string, stashRef: string) => Promise<GitStashEntry[]>
    stashClear: (workspacePath: string) => Promise<GitStashEntry[]>
  }
  ```

### 2. Git Stash 서비스 실행 규칙 및 경계 불변식
- **입력·경로 보안 및 활성 워크스페이스 검증**:
  - IPC 계층은 요청된 `workspacePath`가 호출 세션의 현재 열린 활성 워크스페이스 루트와 일치하는지 검증합니다.
  - `stashRef`는 엄격 정규식(`^stash@\{\d+\}$`)으로만 허용하고, `stashHash`는 `7~64`자 16진수 해시 형식만 허용해 임의 리비전/옵션 인젝션을 차단합니다.
  - 경로 목록(`paths`) 및 Diff 대상 경로는 저장소 루트 내부 여부, 심볼릭 링크 탈출(워킹 트리에서 삭제된 `D` 파일 포함 현존 상위 디렉터리 실경로 검증), `.git` 세그먼트 접근을 차단하며, 모든 Git CLI 호출은 `execFile`/`spawn` 인자 배열(`--` 옵션 분리자 포함)로 실행합니다.
- **첫 커밋 전(`isUnborn`) 저장소 처리**:
  - `HEAD` 커밋이 없는 저장소에서 `stashList`는 빈 배열(`[]`)을 반환하고, `stashCreate`는 `"아직 커밋된 내역이 없어 Stash를 생성할 수 없습니다."` 오류를 반환합니다.
- **범위별 Stash 생성 규칙 (`stashCreate`)**:
  - **`scope === 'unstaged'` (`Changes`만 보관 · `Staged Changes` 유지)**:
    - 실행 시점의 최신 `GitStatus`를 재조회해 `unstaged` 항목과(`includeUntracked !== false`일 때) `untracked` 항목을 대상 경로로 수집합니다. 대상이 `0`건이면 명확한 한국어 오류를 반환합니다.
    - 대상 경로가 `staged` 경로 집합과 전혀 겹치지 않으면 pathspec 기반 `git stash push [--include-untracked] [-m <msg>] -- <targetPaths>`를 실행해 `Staged Changes`를 인덱스와 함께 완전히 격리합니다(추후 `Pop` 시 이미 커밋된 Staged 파일과의 불필요한 충돌 방지).
    - 대상 경로 중 동일 파일이 `Staged + Unstaged` 동시 변경(`MM` 등)에 해당하는 항목이 하나라도 있으면 `git stash push --keep-index [--include-untracked] [-m <msg>]`로 폴백하여 Staged 인덱스를 유지한 채 미스테이지 변경과 선택 시 미추적 파일을 보관합니다.
  - **`scope === 'all'` (전체 보관)**:
    - 전체 대상(`staged` + `unstaged` + 선택 시 `untracked`)이 `0`건이면 오류를 반환하고, 아니면 `git stash push [--include-untracked] [-m <msg>]`를 실행합니다.
  - **`scope === 'paths'` (선택 파일 보관)**:
    - `paths`가 비어 있으면 오류를 반환하고, 경로 보안 검증을 통과한 대상만 `git stash push [--include-untracked] [-m <msg>] -- <validatedPaths>`로 보관합니다.
- **복원 (`stashApply` / `stashPop`) 및 삭제 (`stashDrop` / `stashClear`) 규칙**:
  - `stashApply` 및 `stashPop`은 `--index` 없이 표준 `git stash apply <ref>` / `git stash pop <ref>`를 실행해 보관된 변경을 워킹 트리(`Changes`)로 복원합니다. `pop` 중 병합 충돌이 발생하면 Git이 자동으로 해당 Stash를 유지하므로 삭제하지 않고 충돌 오류 메시지를 반환합니다.
  - `stashDrop`은 지정한 `stashRef`를 삭제(`git stash drop <ref>`)한 뒤 최신 `GitStashEntry[]`를 반환하고, `stashClear`는 전체 Stash를 비운(`git stash clear`) 뒤 빈 최신 목록을 반환합니다.
- **상세 조회 (`stashDetail`) 및 `kind: 'stash'` Diff 산출 규칙**:
  - `stashDetail`은 추적 변경 파일(`git diff --name-status -z -M <hash>^1 <hash>`)을 추출한 뒤, `-u`로 보관된 3번째 부모 트리(`<hash>^3`)가 존재하면 `git ls-tree -r -z --name-only <hash>^3` 결과를 상태 `'?'`로 합쳐 반환합니다.
  - `kind: 'stash'` Diff는 `status === '?'`일 때 `<stashHash>^3:<safePath>` 블롭을 최대 `1MB`(`GIT_DIFF_MAX_BYTES`) 상한과 NUL 바이트 바이너리 감지로 읽어 전체 추가(`+`) Unified Patch로 구성하고, 그 외 상태는 `<stashHash>^1 ↔ <stashHash>`(`-M --find-renames --unified=3`) 비교를 동일 상한·바이너리 감지로 산출하며 `existsInWorkspace`를 함께 반환합니다.
- **오류 안내 보강**:
  - 미커밋 로컬 변경 사항으로 인한 차단 오류(`would be overwritten by`, `please commit your changes or stash them`) 안내 문구에 커밋 또는 Stash로 임시 보관 후 다시 시도하라는 힌트를 포함합니다.

### 3. 3단 아코디언 레이아웃 및 세션 상태 계약
- **Git 패널 상하 분할 상태 모델** (프로토타입 B안 기준 확정 세션 상태 — `config.json`에 저장하지 않음):

  ```ts
  export interface GitPanelSplitState {
    isChangesCollapsed: boolean // 기본값 false
    isStashesCollapsed: boolean // 기본값 true (0건 기본 접힘, 생성 시 자동 펼침)
    isGraphCollapsed: boolean // 기본값 false
    changesHeightRatio: number // clamp(ratio, 0.2, 0.8), 기본값 0.5
  }
  ```

- **배치 및 높이 배분 규칙**:
  - **Git 패널**은 `status.isRepo === true`일 때 **Changes 섹션** → **Stashes 섹션** → **Graph 섹션** 순서로 3단 아코디언을 항상 렌더링합니다.
  - **Stashes 섹션**은 펼쳐졌을 때: **Changes 섹션** 또는 **Graph 섹션** 중 하나라도 펼쳐져 있으면 콘텐츠 맞춤 컴팩트 높이(최대 약 `180px`, 초과 시 본문 내부 세로 스크롤)를 사용하고, 양쪽 섹션이 모두 접혀 있을 때만 남은 세로 공간을 `flex: 1`로 채웁니다.
  - **Changes 섹션**과 **Graph 섹션**이 모두 펼쳐져 있을 때는 기존 단일 **섹션 리사이저**(`20%~80%`, 기본 `50%`, 드래그·상하 방향키·더블클릭 복원)를 유지해 두 섹션의 남은 세로 공간을 배분합니다.
  - 워크스페이스 전환 시 `isStashesCollapsed` 기본값(`true`)과 확장된 Stash 상세 상태를 초기화합니다.

### 4. UI 진입점 · 입력 다이얼로그 · 확인 다이얼로그 · 버퍼/탭 동기화 불변식
- **Stash 생성 진입점 및 활성화 조건**:
  - **`Changes` 하위 그룹 헤더**: 기존 `전체 롤백` 왼쪽에 원클릭 Stash 아이콘(`aria-label="Changes만 Stash"`, `Changes` 파일 `0`건 또는 `pendingAction !== null` 시 비활성화)을 배치합니다. 클릭 시 별도 다이얼로그 없이 `scope: 'unstaged', includeUntracked: true`로 즉시 보관합니다.
  - **`Changes` 개별 파일 행**: 기존 호버/포커스 액션 영역(`파일 열기`·`롤백`·`Stage`)에 원클릭 Stash 아이콘(`aria-label="${file.path} Stash"`)을 추가하고 호버/포커스 시 4개 아이콘이 잘리지 않도록 액션 영역 최대 너비를 확장합니다(비호버 시 `max-width: 0`으로 파일명/디렉토리 경로 영역 유지, `Staged Changes` 파일 행에는 미노출). 클릭 시 `scope: 'paths', includeUntracked: true`로 해당 파일 1개만 즉시 보관합니다.
  - **Stashes 섹션 헤더**: 접기/펼치기 토글(`aria-expanded`) + 보관 개수 배지 + 우측 액션 `+`(Stash 입력 다이얼로그 열기, 변경 `0`건 또는 `pendingAction !== null` 시 비활성화) + `Clear All`(전체 Stash 삭제, Stash `0`건 또는 `pendingAction !== null` 시 비활성화)을 배치합니다.
  - **Git 패널 `...` 더 보기 메뉴**: `Stash Changes...`(기본 범위 `'unstaged'`), `Stash All Changes...`(기본 범위 `'all'`), `Clear All Stashes`(`danger: true`, `0`건 시 비활성화) 항목을 추가합니다.
- **Stash 입력 다이얼로그**:
  - 선택적 메시지 입력창(빈 입력 허용 · `Enter` 즉시 보관 · `Esc` 취소), 보관 범위 선택(`Changes만 보관 (Staged 유지)` / `전체 보관 (Staged 포함)` — 선택 가능한 항목이 `0`건인 범위는 안내 또는 비활성화), `미추적 파일(?) 포함` 체크박스(기본 체크)를 제공합니다.
- **Stash 목록 항목 · 인라인 상세 · Diff 탭 미리보기**:
  - 각 Stash 행은 메시지, `stash@{n}` 참조, 포맷된 시각을 표시하며, 호버/포커스 액션으로 `Pop`(복원 후 삭제), `Apply`(복원 · 목록 유지), `Drop`(개별 삭제) 버튼을 제공합니다. 액션 버튼 클릭은 행 클릭(인라인 파일 목록 토글)과 분리됩니다.
  - `Drop` 및 `Clear All` 실행 전에는 기존 `ConfirmDialogTone = 'danger'` **확인 다이얼로그**에서 대상 `ref`·메시지(또는 전체 개수)와 영구 삭제 경고를 확인받으며, 취소 시 아무 작업도 수행하지 않습니다.
  - Stash 행 클릭 시 한 번에 하나의 Stash 상세(`idle`/`loading`/`loaded`/`error`)를 인라인으로 펼쳐 변경 파일 목록을 보여주고, 내부 파일을 클릭하면 활성 **편집기 영역**에 `kind: 'stash'` 읽기 전용 **Diff 탭**을 엽니다(기존 활성 영역 **Diff 탭** 교체 재사용 규칙, **좌우 비교(Side-by-Side)**/**인라인(Inline)** 토글, 워크스페이스 존재 시 `파일 열기` 버튼 지원).
- **문서 버퍼 · 폴더 트리 · Diff 탭 완전 동기화 및 작업 직렬화**:
  - 모든 Stash 생성·복원·삭제는 기존 Git 뮤테이션 직렬화 락(`pendingAction !== null` 동안 동시 실행 및 파일 감시 덮어쓰기 차단)을 공유하며, 완료 시 최신 `GitStatus`와 `GitStashEntry[]`를 함께 갱신합니다.
  - `stashCreate` 전에는 보관 대상 경로에 한정해(`all`이면 전체 변경 경로), `stashApply`/`stashPop` 전에는 워크스페이스 전체에 대해 미저장(`●`) **문서 버퍼** 확인(`'저장 후 진행'` / `'저장 없이 진행'` / `'취소'`)을 실행합니다(생성 시 비대상 미저장 문서는 무간섭).
  - `stashCreate` 성공 후(`'저장 없이 진행'` 선택 포함) 보관 대상 경로의 열린 **문서 버퍼**는 예약된 자동 저장 타이머를 취소하고 디스크 상태에 맞춰 강제 정합화합니다(워킹 트리에서 사라진 미추적 문서 탭은 추가 닫기 확인 없이 **메인 창**·**보조 창**에서 자동 닫기). 대상 경로의 열린 `unstaged` **Diff 탭**(`all`이면 `staged` 포함)도 자동 닫고, **폴더 트리**·**액티비티 바** 배지를 갱신하며 **Stashes 섹션**을 자동으로 펼칩니다.
  - `stashApply`/`stashPop` 완료(충돌 실패 포함) 후 **폴더 트리**·**문서 버퍼**·열린 `unstaged` **Diff 탭**을 재조정하고, `stashPop`/`stashDrop`/`stashClear`로 사라진 `stashHash`를 가리키는 열린 `kind: 'stash'` **Diff 탭**은 자동 닫기하며 확장 중이던 인라인 상세도 목록에서 사라지면 자동으로 정리합니다.
- **도메인 용어집 동기화**:
  - 마지막 티켓에서 `CONTEXT.md`에 **Stashes 섹션** 용어를 추가하고 **Git 패널**, **Changes 섹션**, **섹션 리사이저**, **Diff 탭 / Diff 뷰어**, **확인 다이얼로그** 설명을 갱신합니다.

## Testing Decisions (테스트 결정사항)

- **검증 기준**: 내부 구현 상태나 CSS 클래스가 아니라 접근 가능한 역할·이름(`getByRole`, `getByLabelText`)과 공개 서비스 계약을 통해 사용자가 관찰하는 엔드투엔드 동작을 검증합니다. 모든 테스트는 격리된 임시 디렉터리(`mkdtemp`)와 인메모리 하네스에서 수행하며 실제 작업 저장소나 사용자 `config.json`에 영향을 주지 않습니다.
- **사전 합의된 테스트 심 (Pre-agreed Seams)**:
  1. **`<App />` 멀티 윈도우 + 인메모리 `window.wikiApi` 통합 심 (`createMultiWindowWikiHarness` + React Testing Library)**
     - **Catches**: **Stashes 섹션** 3단 아코디언 접힘·자동 펼침, `Changes` 헤더/개별 파일 원클릭 Stash 및 Stash 입력 다이얼로그, `Pop`/`Apply`/`Drop(danger)`/`Clear All(danger)` 동작, 미저장 **문서 버퍼** 보호 및 **메인 창**·**보조 창** 탭/버퍼/폴더 트리/`unstaged`·무효 `stash` **Diff 탭** 동기화, 인라인 파일 목록·읽기 전용 Stash **Diff 탭** 회귀.
     - **Misses**: 실제 `git` CLI 서브프로세스 실행, OS 파일 감시 이벤트 타이밍, 포인터 드래그 픽셀 좌표.
  2. **Git 서비스 통합 심 (임시 디렉터리 기반 격리 실제 Git 저장소 / Vitest)**
     - **Catches**: 실제 `git` 바이너리에서의 `unstaged` 전용 Stash(분리 경로 pathspec vs `MM` 동시 변경 `--keep-index` 폴백) 및 미추적 `?` 포함, `all`/`paths` Stash, `isUnborn` 방어, `pop` 충돌 시 Stash 보존, `drop`/`clear`, 3번째 부모(`^3`) 미추적 파일 포함 상세(`stashDetail`) 및 `kind: 'stash'` Diff(바이너리·`1MB` 절단·경로/`stashRef`/`stashHash` 보안 검증) 오류.
     - **Misses**: Electron IPC 채널 바인딩과 렌더러 컴포넌트·다이얼로그 상태 전이.
  3. **Git IPC 핸들러 & Preload 브리지 경계 심 (가짜 `IpcMainLike` / `IpcRendererLike` / Vitest)**
     - **Catches**: 신규 Stash IPC 채널(`git:stash-list`, `git:stash-detail`, `git:stash-create`, `git:stash-apply`, `git:stash-pop`, `git:stash-drop`, `git:stash-clear`)의 활성 워크스페이스 일치 검증·라우팅 누락 및 `window.wikiApi.git` 브리지 인자 매핑 불일치.
     - **Misses**: Git CLI 출력 파싱 세부 로직과 렌더러 UI 상호작용.
  4. **Git 패널 3단 아코디언 분할 상태 순수 함수 심 (Vitest 단위 테스트)**
     - **Catches**: `isStashesCollapsed` 기본 접힘·자동 펼침 토글과 **Changes 섹션**·**Graph 섹션** 접힘 조합에 따른 **섹션 리사이저** 노출·높이 비율(`20%~80%`) 배분 계산 오류.
     - **Misses**: 실제 DOM 스크롤·`max-height` 레이아웃과 포인터 드래그 처리.
- *(위 심 목록은 `/ticket-runner`의 사전 합의된 심(Pre-agreed Seams)으로 사용됩니다.)*
- **참고할 기존 테스트 패턴 (Prior Art)**:
  - `<App />` 멀티 윈도우 및 Git 롤백/그래프 통합 테스트의 `createMultiWindowWikiHarness` 패턴
  - 격리된 임시 저장소(`mkdtemp` + 로컬 `.gitconfig`) 기반 실제 `git` 바이너리 서비스·Diff 통합 테스트 패턴
  - 가짜 `IpcMainLike` / `IpcRendererLike` 기반 IPC 핸들러 및 Preload 브리지 단위 테스트 패턴
  - Git 패널 분할 비율 및 상태 전이 순수 함수 단위 테스트 패턴

## Out of Scope (범위 제외 사항)

- `Pull`, `Sync`, `Commit & Sync` 실행 시 백그라운드 자동 임시 보관(Auto-Stash) 및 자동 복원
- `Pop` / `Apply` 실행 시 `--index` 옵션을 통해 `Staged Changes` 상태까지 함께 복원하는 기능
- Stash 항목에서 새 브랜치를 파생(`git stash branch`)하거나 기존 Stash 메시지를 수정하는 기능
- **Diff 탭** 내부에서 특정 줄이나 헝크(Hunk) 단위로만 부분 Stash하는 기능
- **Stashes 섹션** 접힘 여부(`isStashesCollapsed`)를 `config.json`에 영속 저장하는 기능

## Further Notes (기타 참고사항)

- **하위 폴더 워크스페이스 호환성**: 열린 워크스페이스가 상위 Git 저장소의 하위 디렉터리인 경우에도 `GitStatus`·`GitStashDetail`의 저장소 루트 기준 상대 경로 검증과 워크스페이스 내 열린 **문서 버퍼** 경로 매핑이 일관되게 동작해야 합니다.
- **`stash@{n}` 인덱스 이동 경합 방지**: Git Stash 인덱스는 생성·Pop·Drop 시 매번 재정렬되므로, 모든 Stash 변경 작업은 단일 Git 작업 직렬화 락 안에서 실행하고 완료 직후 최신 `GitStashEntry[]`를 재조회하며, Diff 조회 요청(`kind: 'stash'`)은 인덱스가 바뀌더라도 대상을 정확히 식별할 수 있도록 불변 커밋 해시(`stashHash`)를 기준으로 계산합니다.
- **대용량·로그 보호**: Stash Diff 패치 응답은 `1MB`(`GIT_DIFF_MAX_BYTES`) 상한으로 안전하게 절단(`isTruncated: true`)하며, IPC 오류 로깅 시 패치 원문 전체가 로그 파일에 남지 않도록 주의합니다.
