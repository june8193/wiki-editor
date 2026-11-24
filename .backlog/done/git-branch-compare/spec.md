# Spec: 브랜치 및 워크트리 간 코드 Diff 비교 (Git Branch Compare)

## Problem Statement (문제 정의)

현재 **Git 뷰**의 **Git 패널**은 워킹 트리(`Changes 섹션`), 임시 보관(**Stashes 섹션**), 단일 커밋 히스토리(**Graph 섹션**) 중심의 비교만 지원하며, 두 브랜치 또는 연결된 워크트리 간의 전체 변경 사항을 PR(Pull Request) 리뷰처럼 한눈에 비교하는 전용 화면이 없습니다.

- 사용자는 기능 브랜치나 워크트리에서 작업한 결과를 기준 브랜치(`main`, `origin/main` 등)와 비교해 어떤 파일이 얼마나 바뀌었고 어떤 커밋이 포함되었는지 검토하고 싶지만, 현재는 커밋을 하나씩 열어보거나 외부 도구를 사용해야 합니다.
- 기존 **Diff 뷰어**는 **좌우 비교(Side-by-Side)**와 **인라인(Inline)** 전환은 지원하지만, 수정된 줄 내 실제 변경 토큰을 강조하는 단어 단위(Intra-line) 하이라이트와 코드 구문 강조(Syntax Highlighting)가 없어 코드 리뷰 가독성이 떨어집니다.

## Solution (해결 방안)

Bitbucket PR Diff의 핵심 워크플로를 `wiki-editor`의 **액티비티 바** + **왼쪽 사이드바** + **편집 공간** 구조에 맞춰 구현합니다.

1. **액티비티 바에 독립 `Compare 뷰` 신설**:
   - **액티비티 바**에 **Compare 뷰** 아이콘을 추가하고, 선택 시 **왼쪽 사이드바**에 전용 **Compare 패널**을 단독 표시합니다.
   - 워크스페이스 격리 원칙에 따라 **Compare 뷰**는 현재 **메인 창** 세션에 열린 저장소를 대상으로 동작하며, 다른 저장소 코드베이스를 비교할 때는 기존 **워크스페이스 뷰**의 `'새 창에서 열기'`로 해당 저장소를 별도 **메인 창**에 열어 동일하게 비교합니다.
2. **Base / Compare 선택기(Worktree · Local · Remote) 및 `3-dot` / `2-dot` 전환**:
   - **Compare 패널** 상단에서 검색 가능한 Ref 피커로 **Worktrees**(커밋된 `HEAD` 기준, Detached HEAD 포함), **Local Branches**, **Remote Branches**를 선택할 수 있고, `⇄` 스왑 버튼과 새로고침을 제공합니다.
   - 기본 비교 방식은 Bitbucket PR과 동일한 **`3-dot` (`base...compare`, merge-base 이후 `compare` 변경분)**이며, 필요 시 **`2-dot` (`base..compare`, 두 브랜치 최종 스냅샷 직접 비교)**로 전환할 수 있습니다.
3. **`Files` 트리(`+N -M` 통계 · 필터) 및 `Commits` 인라인 상세**:
   - **Files** 서브 탭에서 단일 하위 경로 압축 폴더 트리, 파일명 실시간 필터, 파일별/전체 `+N -M` 줄 수 통계를 제공합니다.
   - **Commits** 서브 탭에서 두 Ref 사이에 포함된 커밋 목록을 표시하며, 커밋 클릭 시 **Graph 섹션**과 동일하게 인라인 커밋 상세(해시 복사, 본문, 변경 파일 목록)를 펼치고 파일 클릭 시 해당 커밋의 **Diff 탭**을 엽니다.
4. **단일 파일 포커스 `Diff 탭` + 이전/다음 네비게이션 + 공통 `Diff 뷰어` 고도화**:
   - **Files** 목록에서 파일을 선택하면 활성 **편집기 영역**에 읽기 전용 **Diff 탭**을 열어 단일 파일 포커스 방식으로 Diff를 표시하며, 헤더에 **이전/다음 파일(`↑`/`↓`) 네비게이션**과 `{index} / {total}` 카운터를 제공합니다.
   - 기존 **Changes 섹션**·**Stashes 섹션**·**Graph 섹션** 및 **Compare 뷰**가 공유하는 **Diff 뷰어**에 **단어 단위(Intra-line) 변경 하이라이트**와 **신택스 하이라이팅**을 공통 적용합니다.

## User Stories (사용자 스토리)

1. As a 개발자·위키 작성자, I want **액티비티 바**에서 **Compare 뷰**를 선택해 **왼쪽 사이드바**에 **Compare 패널**을 열고(초기 진입 시 `Base`는 `origin/HEAD` 대상 또는 `main`/`master`, `Compare`는 현재 체크아웃 브랜치 자동 선택), so that 별도 설정 없이 즉시 현재 브랜치의 변경 사항을 PR처럼 검토할 수 있습니다.
2. As a 개발자, I want `Base`·`Compare` 드롭다운에서 검색 필터로 **Worktrees**(Detached HEAD 포함 커밋된 `HEAD`), **Local Branches**, **Remote Branches**를 고르고 `⇄` 버튼으로 기준과 대상을 맞바꾸기를 원하며, so that 로컬·원격·워크트리 간 어떤 조합이든 빠르게 비교할 수 있습니다.
3. As a 개발자, I want **`3-dot (PR 방식)`**과 **`2-dot (직접 비교)`** 토글을 전환해 분기점 이후 내 브랜치 변경분만 볼지 두 브랜치 최종 스냅샷 차이를 직접 볼지 선택하기를 원하며, so that PR 코드 리뷰와 브랜치 최종 상태 비교를 한 화면에서 모두 수행할 수 있습니다.
4. As a 개발자, I want **Compare 패널** 상단 요약 바에서 총 변경 파일 수와 전체 `+N -M` 줄 수를 확인하고, **Files** 탭에서 파일명 필터링과 경로 압축 폴더 트리(파일별 상태 `M`/`A`/`D`/`R`/`C` 및 `+N -M`)를 탐색하기를 원하며, so that 변경 규모를 파악하고 원하는 파일로 바로 이동할 수 있습니다.
5. As a 개발자, I want **Files**에서 선택한 파일 1개만 우측 활성 **편집기 영역**의 읽기 전용 **Diff 탭**에 표시하되, 헤더의 **이전/다음(`↑`/`↓`)** 버튼으로 필터링된 파일 목록을 순서대로 넘기며 **좌우 비교**/**인라인** 전환과 `파일 열기`를 사용하기를 원하며, so that 집중된 화면에서 여러 변경 파일을 빠르게 순회 리뷰할 수 있습니다.
6. As a 개발자, I want **Commits** 서브 탭에서 비교 범위에 포함된 커밋 목록을 보고, 특정 커밋을 클릭해 인라인 커밋 상세(해시 복사, 메시지 본문, 변경 파일)를 펼친 뒤 파일 클릭 시 해당 커밋의 **Diff 탭**을 열기를 원하며, so that 커밋 단위의 변경 맥락까지 함께 추적할 수 있습니다.
7. As a 개발자, I want **Compare 뷰**뿐 아니라 기존 **Changes 섹션**·**Stashes 섹션**·**Graph 섹션**에서 여는 모든 **Diff 뷰어**에서 수정된 줄의 실제 바뀐 단어·토큰만 진하게 강조(Intra-line diff)되고 파일 확장자에 맞는 신택스 하이라이팅이 적용되기를 원하며, so that 어떤 Diff를 열더라도 변경 지점을 한눈에 식별할 수 있습니다.
8. As a 사용자, I want 비Git 폴더·첫 커밋 전(`isUnborn`) 저장소·동일 Ref 비교(`0 files changed`)·대용량/바이너리 파일·워크스페이스 전환 시에도 오류가 나지 않고 명확한 안내와 상태 초기화를 제공받기를 원하며, so that **메인 창**과 **보조 창**을 오가더라도 항상 일관되고 안전한 상태를 유지할 수 있습니다.

## Implementation Decisions (구현 결정사항)

### 1. 공유 데이터 스키마 및 API 계약 (UI 프로토타입·기존 Git API 패턴 기반 확정)

```ts
export type GitCompareRefKind = 'worktree' | 'local-branch' | 'remote-branch'
export type GitCompareMode = 'three-dot' | 'two-dot'

export interface GitCompareRef {
  id: string
  kind: GitCompareRefKind
  ref: string
  displayName: string
  worktreeName?: string
  branchName?: string | null
  shortHash?: string
  isDetached?: boolean
  isCurrent?: boolean
}

export interface GitCompareRefList {
  defaultBaseRef: string | null
  currentRef: string | null
  worktrees: GitCompareRef[]
  localBranches: GitCompareRef[]
  remoteBranches: GitCompareRef[]
}

export interface GitCompareChangedFile extends GitChangedFile {
  additions: number | null
  deletions: number | null
  isBinary: boolean
}

export interface GitCompareSummary {
  baseRef: string
  compareRef: string
  mode: GitCompareMode
  mergeBaseHash: string | null
  totalAdditions: number
  totalDeletions: number
  files: GitCompareChangedFile[]
  commits: GitGraphCommit[]
}

export interface GitCompareSummaryRequest {
  baseRef: string
  compareRef: string
  mode: GitCompareMode
}

export type GitDiffRequest =
  | ({ kind: 'staged' } & GitChangedFile)
  | ({ kind: 'unstaged' } & GitChangedFile)
  | ({ kind: 'commit'; commitHash: string; shortHash: string } & GitChangedFile)
  | ({ kind: 'stash'; stashRef: string; stashHash: string } & GitChangedFile)
  | ({
      kind: 'branch-compare'
      baseRef: string
      compareRef: string
      mode: GitCompareMode
    } & GitChangedFile)
```

- `WikiGitApi`에 `compareRefs(workspacePath: string): Promise<GitCompareRefList>`와 `compareSummary(workspacePath: string, request: GitCompareSummaryRequest): Promise<GitCompareSummary>`를 추가합니다.

### 2. Git 서비스 실행 규칙 및 보안 불변식

- **활성 워크스페이스 격리**: 모든 비교 IPC 핸들러는 요청된 `workspacePath`가 호출 세션의 현재 열린 활성 워크스페이스 루트와 일치하는지 엄격히 검증합니다.
- **Ref 및 경로 입력 검증**:
  - 단일 Ref 문자열은 선행 `-`, 공백, 제어문자, NUL 바이트, `..` 시퀀스 등 옵션/범위 인젝션 패턴을 차단하고 `execFile`/`spawn` 인자 배열과 `--` 옵션 분리자로만 Git CLI를 호출합니다.
  - 파일 경로 및 rename `origPath`는 기존 경로 보안 검사(저장소 루트 내부, `.git` 세그먼트 차단, 심볼릭 링크 탈출 방지)를 그대로 적용합니다.
- **Worktree 처리 범위**: `git worktree list --porcelain`에서 연결된 워크트리의 폴더명, 체크아웃 브랜치, `HEAD` 커밋 해시, `detached` 여부만 읽어 커밋된 `HEAD` 기준으로 비교합니다(다른 워크트리의 미커밋 워킹 트리는 읽지 않음).
- **기본 Base / Compare 해석**:
  - `defaultBaseRef`: `origin/HEAD`가 가리키는 심볼릭 대상이 있으면 우선 사용하고, 없으면 `main`, `master`, 그 외 첫 번째 브랜치 순으로 폴백합니다.
  - `currentRef`: 현재 체크아웃된 브랜치(Detached HEAD인 경우 단축 해시).
- **3-dot / 2-dot 비교 규칙**:
  - `three-dot`: `git merge-base <baseRef> <compareRef>`를 구해 `mergeBase`가 존재하면 `diff`와 `numstat`에 `<baseRef>...<compareRef>`, 커밋 목록에 `<baseRef>..<compareRef>`를 사용합니다. (공통 조상이 없는 분리 히스토리에서는 `2-dot` 폴백 또는 빈 merge-base 안내를 일관되게 처리합니다.)
  - `two-dot`: `diff`·`numstat`에 `<baseRef>..<compareRef>`를 사용하고, 커밋 목록은 `<baseRef>..<compareRef>`를 조회합니다.
  - Diff 본문은 기존과 동일하게 `GIT_DIFF_MAX_BYTES`(1MB) 상한과 바이너리 판별, `existsInWorkspace` 확인을 적용합니다.

### 3. 공통 Diff 뷰어 및 Compare 패널 상태 규칙

- **단어 단위(Intra-line) Diff**:
  - 연속된 삭제 줄 묶음과 추가 줄 묶음이 1:1 또는 동일 개수로 대응될 때(및 과도한 길이의 줄을 제외하는 성능 가드 내에서) 토큰 단위 LCS로 변경된 구간만 강조합니다.
- **신택스 하이라이팅**:
  - 이미 설치된 `@codemirror/language-data`와 `@lezer/highlight`를 활용해 파일 확장자별 경량 하이라이팅을 적용하며, 미지원 확장자나 비정상적으로 긴 줄은 일반 텍스트로 안전하게 폴백합니다.
- **Compare 패널 세션 상태**:
  - 선택한 `baseRef`, `compareRef`, `mode`, `subTab`(`files`/`commits`), `fileFilter`는 **왼쪽 사이드바** 뷰 전환·접기 시 세션 메모리에 유지되고, 워크스페이스 전환 시 초기화되며 `workspace-state.json`에는 저장하지 않습니다.
  - **보조 창**에는 **액티비티 바**·**왼쪽 사이드바**가 없지만, **보조 창**으로 **Diff 탭**을 이동/복제했을 때 동일한 **Diff 뷰어**(단어 하이라이트·신택스 하이라이팅·좌우/인라인 토글)가 정상 렌더링되어야 합니다.

## Testing Decisions (테스트 결정사항)

- **검증 기준**: 내부 파싱 함수나 private 헬퍼의 구현 세부사항이 아니라, 공개 IPC 계약·실제 Git 저장소 동작·사용자 관점 UI 인터랙션을 기준으로 검증합니다.
- **사전 합의된 테스트 심(Pre-agreed Seams)**:
  1. **`GitService` + `registerGitIpc` 통합 테스트 심** (실제 임시 Git 샌드박스 및 `git worktree` 환경):
     - *Catches*: `for-each-ref` / `worktree list --porcelain` 파싱, `3-dot` vs `2-dot` 범위 차이, `numstat`·rename·바이너리·1MB 절단, 포함 커밋 조회, 리비전·경로·활성 워크스페이스 보안 경계 위반.
     - *Misses*: 렌더러 UI 상태, 트리 필터링, CSS 스타일 및 시각 레이아웃.
  2. **`App` + 인메모리 `WikiApi` 하네스 통합 테스트 심**:
     - *Catches*: **액티비티 바** **Compare 뷰** 전환, Ref 피커(Worktrees/Local/Remote)·검색·스왑, `3-dot`/`2-dot` 전환 동기화, **Files** 트리 필터·통계·이전/다음 파일 이동, **Commits** 인라인 상세 펼치기 및 커밋 **Diff 탭** 전환, 워크스페이스 전환·비저장소 상태 처리.
     - *Misses*: 실제 `git` 바이너리 실행 동작 및 CSS 시각 렌더링.
  3. **`GitDiffViewer` 컴포넌트 테스트 심**:
     - *Catches*: 공통 **Diff 뷰어**(Changes/Stashes/Graph/Compare)의 단어 단위 하이라이트, 신택스 하이라이팅, 좌우/인라인 토글, 이전/다음 파일 네비게이션, 삭제 파일 `파일 열기` 비활성.
     - *Misses*: IPC 통신 및 앱 셸 **편집기 영역** 탭 생명주기.
- **참고할 기존 테스트 패턴(Prior art)**:
  - 백엔드 Git 통합 테스트: `GitService` 임시 샌드박스 기반 diff/log/stash/remote 통합 테스트 패턴.
  - 렌더러 통합 테스트: `App` + 인메모리 `WikiApi` 하네스 기반 Git 사이드바·Diff 탭 테스트 패턴.
  - 컴포넌트 테스트: `GitDiffViewer` 단위/컴포넌트 테스트 패턴.

## Out of Scope (범위 제외 사항)

- 다른 워크트리의 미커밋(Working Tree) 변경 사항까지 스냅샷으로 비교하는 기능 (커밋된 `HEAD`까지만 지원)
- 위키 워크스페이스 창 내부에서 외부 저장소 폴더를 직접 선택해 비교하는 교차 저장소 선택기 (기존 멀티 **메인 창** `'새 창에서 열기'`로 대응)
- Bitbucket PR의 `'Viewed'` 체크박스·리뷰 진행률, 인라인 PR 코멘트·승인 워크플로
- 공백 변경 무시(`-w`) 토글, 숨겨진 컨텍스트 줄 펼치기(Expand context), 전체 파일 연속 스크롤 보기 모드

## Further Notes (기타 참고사항)

- 확정된 UI 레이아웃 및 인터랙션 레퍼런스: 대화 중 승인된 `branch-diff-prototype.html` 프로토타입(44px **액티비티 바** Compare 아이콘, 320px **왼쪽 사이드바** Compare 패널, 우측 단일 파일 포커스 **Diff 탭**).
- 구현 완료 시 `CONTEXT.md`(공식 용어: **Compare 뷰**, **Compare 패널**)와 `docs/manual.md`(사용자 매뉴얼 규칙)를 함께 갱신합니다.
