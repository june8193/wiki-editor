# Spec: Compare 폴더트리 UI·경로 복사 및 VS Code식 다중 Diff 탭

## Problem Statement (문제 정의)

1. **Compare 패널 폴더 행 시각적 음영 문제**: **Compare 뷰**의 **Compare 패널** 폴더 트리에서 폴더 행 버튼이 정의되지 않은 스타일 클래스를 참조하여 브라우저 기본 `<button>` 배경 음영이 그대로 노출되고 있어 가독성이 떨어집니다.
2. **Git·Compare 경로 복사 및 컨텍스트 메뉴 부재**: **탐색기 뷰**에서는 파일/폴더 우클릭으로 `상대 경로 복사`와 `절대 경로 복사`가 가능하지만, **Compare 패널** 폴더 트리와 **Git 뷰** **Changes 섹션**(리스트·트리)에는 우클릭 컨텍스트 메뉴가 없어 변경 파일이나 디렉토리 경로를 빠르게 복사하거나 새 탭으로 열기 어렵습니다.
3. **단일 Diff 탭 제한**: 현재 동일한 **편집기 영역** 내에서는 **Diff 탭**이 항상 1개만 유지·덮어쓰기 되어, 여러 변경 파일의 **Diff 뷰어**를 동시에 열어두고 비교·검토할 수 없습니다.

## Solution (해결 방안)

1. **Compare 폴더 행 스타일 통일**: **Compare 패널** 폴더 행이 **Git 뷰** **Changes 섹션** 폴더 트리와 동일한 투명 배경 및 호버/포커스 스타일을 사용하도록 정렬합니다.
2. **VS Code식 Preview + Pin 다중 Diff 탭 도입**: **Compare 패널**, **Git 뷰** **Changes 섹션**, **Graph 섹션** 커밋 상세, **Stashes 섹션** 상세 등 모든 **Diff 탭** 소스에 일관된 **Preview + Pin** 모델을 적용합니다.
   - 단일 클릭은 임시 Preview 탭 1개(탭 제목 이탤릭 표시)를 재사용합니다.
   - 더블클릭, `Shift+클릭`, 우클릭 `새 탭에서 Diff 열기`, 또는 **탭 바**의 Preview 탭 더블클릭으로 탭을 고정(Pinned)하여 여러 **Diff 탭**을 동시에 유지합니다.
   - **Compare 패널**의 Base/Compare Ref 또는 3-dot/2-dot 모드 변경 시, 고정 여부와 무관하게 열려 있는 모든 `branch-compare` **Diff 탭**을 새 비교 기준으로 일괄 갱신(없는 파일은 닫기)합니다.
3. **Compare·Git 우클릭 컨텍스트 메뉴 추가**: **Compare 패널** 폴더 트리와 **Git 뷰** **Changes 섹션**(리스트·트리 모두)에서 파일 우클릭 시 `새 탭에서 Diff 열기` / `상대 경로 복사` / `절대 경로 복사`를, 폴더 우클릭 시 `상대 경로 복사` / `절대 경로 복사`를 제공합니다.

## User Stories (사용자 스토리)

1. As a 사용자, I want **Compare 패널**의 폴더 트리에서 폴더 행이 기본 버튼 회색 음영 없이 투명 배경과 깔끔한 호버/포커스 스타일로 표시되기를, so that 파일 목록과 폴더 계층을 눈의 피로 없이 한눈에 구분할 수 있습니다.
2. As a 사용자, I want **Compare 패널**이나 **Git 뷰**에서 변경 파일을 단일 클릭하면 임시 Preview **Diff 탭** 1개에서 빠르게 내용을 훑어볼 수 있기를, so that 여러 파일을 훑어보는 동안 **탭 바**가 불필요하게 어지럽혀지지 않습니다.
3. As a 사용자, I want 확인해두고 싶은 변경 파일을 더블클릭하거나 `Shift+클릭`하거나 우클릭 `새 탭에서 Diff 열기`로 열면 고정(Pinned) **Diff 탭**으로 유지되기를, so that 여러 파일의 **Diff 뷰어**를 동시에 띄워두고 오가며 검토할 수 있습니다.
4. As a 사용자, I want **탭 바**에서 이탤릭체로 표시된 Preview **Diff 탭**을 더블클릭해 고정 상태로 전환할 수 있기를, so that 단일 클릭으로 연 Diff도 필요할 때 즉시 보존할 수 있습니다.
5. As a 사용자, I want **Compare 패널**에서 Base/Compare Ref나 비교 방식(3-dot/2-dot)을 변경했을 때 고정된 **Diff 탭**을 포함해 열려 있는 모든 Compare **Diff 탭**이 새 기준으로 갱신되거나 범위 밖 파일은 닫히기를, so that 오래된 Ref 기준의 Diff를 혼동하지 않습니다.
6. As a 사용자, I want **Compare 패널** 폴더 트리와 **Git 뷰** **Changes 섹션**(리스트·트리)에서 파일 또는 압축된 폴더 행을 우클릭해 `상대 경로 복사` 및 `절대 경로 복사`를 실행할 수 있기를, so that **탐색기 뷰**와 동일한 흐름으로 경로를 복사해 문서나 터미널에 붙여넣을 수 있습니다.
7. As a 사용자, I want **Graph 섹션** 커밋 상세와 **Stashes 섹션** 상세의 변경 파일 목록에서도 `Shift+클릭` 또는 더블클릭으로 고정 **Diff 탭**을 열 수 있기를, so that 모든 Git 이력/작업 비교에서 일관된 다중 탭 경험을 누릴 수 있습니다.

## Implementation Decisions (구현 결정사항)

### 1. Compare 폴더 행 스타일 통일
- **Compare 패널** 폴더 트리의 폴더 행 버튼이 **Git 뷰** 폴더 트리 폴더 행과 동일한 스타일 계약(투명 배경, 테두리 없음, 호버/포커스 하이라이트, 들여쓰기 규격)을 공유하도록 통일합니다.

### 2. Diff 탭 Preview + Pin 상태 머신 및 불변식
- **Diff 탭 상태 확장**: 각 `DiffTabState`에 선택적 `isPreview?: boolean` 속성을 추가하고, Diff 탭 열기 옵션에 `pinned?: boolean`을 추가합니다.
- **영역당 Preview 최대 1개 불변식**: 하나의 **편집기 영역**(`PaneState`) 안에는 `isPreview === true`인 **Diff 탭**이 최대 1개만 존재할 수 있습니다.
- **열기 전이 규칙 (`openDiffTab`)**:
  - `shouldPin = Boolean(options.pinned || duplicateFrom)`으로 고정 열기 여부를 결정합니다.
  - **동일 식별 키(`formatGitDiffTabKey`) 매칭 우선**: 대상 **편집기 영역**에 동일 키의 **Diff 탭**이 이미 존재하면 해당 탭을 활성화합니다. 이때 이미 고정된 탭(`isPreview: false`)은 단일 클릭으로 다시 열어도 Preview로 강등되지 않으며, `shouldPin === true`이고 기존 탭이 `isPreview === true`이면 고정(`isPreview: false`)으로 승격합니다.
  - **일반(Preview) 열기 (`!shouldPin`)**: 동일 키 매칭이 없고 대상 영역에 기존 Preview **Diff 탭**(`isPreview === true`)이 있으면 그 탭의 `request`와 `viewMode`를 교체·활성화합니다. 기존 Preview **Diff 탭**이 없으면 `isPreview: true`인 새 **Diff 탭**을 생성합니다.
  - **고정(Pinned) 열기 (`shouldPin`)**: 동일 키 매칭이 없으면 기존 Preview 탭을 건드리지 않고 `isPreview: false`인 새 **Diff 탭**을 추가·활성화합니다.
- **직접 고정 (`pinDiffTab`)**: **탭 바**에서 `isPreview === true`인 **Diff 탭**을 더블클릭하면 `isPreview: false`로 불변 갱신합니다.
- **표시 규칙**: Preview **Diff 탭**은 **탭 바** 항목에 Preview 식별 클래스/속성을 부여해 탭 제목(`.tab-label`)을 이탤릭체(`font-style: italic`)로 표시합니다.
- **분할 이동/복제/창 분리/병합 정규화**:
  - 다른 **편집기 영역**으로 복제(`duplicateTabToOtherPane`)하거나 다른 창에서 드롭 수신(`acceptTransferredTab`)하는 **Diff 탭**은 항상 고정(`pinned: true`)으로 엽니다.
  - 영역 간 탭 이동(`moveTabBetweenPanes`) 또는 분할 해제 병합(`setSplitMode('single')`) 시 대상 영역에 이미 Preview **Diff 탭**이 존재한다면 이동·병합되는 Preview **Diff 탭**을 `isPreview: false`로 정규화해 불변식을 유지합니다.
- **Compare 일괄 갱신 (`reconcileBranchCompareDiffTabs`)**: Base/Compare Ref 또는 3-dot/2-dot 모드가 변경되면 고정 여부(`isPreview`)와 무관하게 열려 있는 모든 `branch-compare` **Diff 탭**을 새 기준으로 갱신(없는 파일은 제거)하며, 각 탭의 기존 `isPreview` 상태는 그대로 보존합니다.
- **Compare 헤더 이전/다음(`↑`/`↓`) 네비게이션**: 순회 시에는 `pinned` 없이 Preview 열기 계약을 사용하여 기존 고정 탭을 덮어쓰지 않고 Preview 탭에서 순회합니다.
- **제스처 매핑**: 모든 Git/Compare 파일 행(Compare Files, Compare Commits 상세, Git Changes, Git Commit 상세, Git Stash 상세)에서 클릭 시 `pinned: event.shiftKey`, 더블클릭 시 `pinned: true`를 전달합니다.

### 3. 경로 복사 포맷 계약
- 저장소 상대 경로(`repoRelativePath`), `repoRoot`, `workspaceRootPath`를 입력받아 복사 문자열을 계산하는 순수 포맷 계약을 정의합니다.
  - **상대 경로 복사(`relative`)**: 대상 경로가 열린 워크스페이스 루트 내부로 해석되면 워크스페이스 기준 상대 경로(POSIX 구분자)를 반환하고, 모노레포 상위 등 워크스페이스 외부 경로면 정규화된 저장소 상대 경로를 반환합니다.
  - **절대 경로 복사(`absolute`)**: `repoRoot ?? workspaceRootPath` 기준 루트에 대상 상대 경로를 플랫폼 경로 구분자 규칙으로 결합해 반환합니다.
  - 경로 압축 트리에서 여러 세그먼트가 합쳐진 폴더 노드(예: `a/b/c`)도 노드의 전체 저장소 상대 경로를 그대로 사용해 동일한 규칙으로 복사합니다.

### 4. 우클릭 컨텍스트 메뉴 계약
- **Compare 패널** 폴더 트리(파일 및 폴더 행)와 **Git 뷰** **Changes 섹션**(리스트·트리 모드의 파일 행 및 트리 모드의 폴더 행)에 공통 컨텍스트 메뉴 컴포넌트를 적용합니다.
- 메뉴 항목 구성:
  - **파일 행**: `새 탭에서 Diff 열기`(고정 탭 열기 실행) · 구분선 · `상대 경로 복사` · `절대 경로 복사`
  - **폴더 행**: `상대 경로 복사` · `절대 경로 복사`
- 외부 클릭·`Esc` 키로 닫히고, **탐색기 뷰** 컨텍스트 메뉴와 동일하게 뷰포트 경계 내로 좌표를 클램핑하며, 클립보드 쓰기 실패 시 기존 오류 배너 채널로 보고합니다.

### 5. 문서 동기화
- 사용자용 기능 및 제스처 변경에 따라 사용자 매뉴얼(`docs/manual.md`)의 Diff 뷰어·Compare 뷰 설명과 도메인 용어집(`CONTEXT.md`)의 **Changes 섹션**, **Compare 패널**, **Diff 탭** 설명을 함께 갱신합니다.

## Testing Decisions (테스트 결정사항)

- **검증 기준**: 내부 구현 세부가 아니라 사용자가 클릭·더블클릭·`Shift+클릭`·우클릭·탭 더블클릭·Ref 전환 시 관찰하는 **Diff 탭** 상태, **탭 바** 렌더링, 클립보드 복사 결과, 폴더 행 클래스 적용 여부를 기준으로 검증합니다.
- **사전 합의된 테스트 심(Pre-agreed Seams)**:
  - **App 통합 테스트 심 (인메모리 워크스페이스·Git 하네스 기반 렌더러 통합)**:
    - Catches: Compare/Git 사이드바의 클릭·더블클릭·`Shift+클릭`·우클릭 컨텍스트 메뉴, **탭 바** Preview/Pin 표시 및 더블클릭 고정, Ref/모드 변경 시 전체 Compare **Diff 탭** 일괄 갱신, 클립보드 경로 복사까지 E2E UI 통합 회귀.
    - Misses: 실제 브라우저 레이아웃/CSS 계산 스타일(배경색 렌더링) 및 네이티브 OS 클립보드 IPC 직렬화.
  - **PaneTabStore 공개 상태 머신 심**:
    - Catches: 단일/분할 **편집기 영역**에서의 Preview 재사용, Pin 승격, 영역당 Preview 최대 1개 불변식, 영역 이동/병합 정규화, `reconcileBranchCompareDiffTabs`의 `isPreview` 보존 및 일괄 갱신 경계 조건.
    - Misses: React UI 이벤트 제스처 바인딩 및 **탭 바** 이탤릭 시각 표현.
  - **Git/Compare 경로 복사 포맷 순수 함수 심**:
    - Catches: 동일 루트, 하위 워크스페이스, 모노레포 외부 경로, 압축 폴더 경로, Windows/POSIX 구분자 조합의 경로 계산 오류.
    - Misses: 클립보드 쓰기 실패 시 UI 오류 배너 노출.
- **참고할 기존 테스트 패턴(Prior art)**: 기존 Compare/Git App 통합 테스트(인메모리 하네스), `PaneTabStore` 단위 테스트, `GitSidebarPanel` 컴포넌트 테스트, **탐색기 뷰** 우클릭 경로 복사 테스트 패턴.

## Out of Scope (범위 제외 사항)

- 일반 **문서 탭(Document Tab)**에 대한 Preview + Pin 모델 도입.
- **Diff 탭**의 앱 재시작·워크스페이스 전환 간 영속 복원.
- Compare/Git 트리에서의 다중 선택(Multi-select) 일괄 경로 복사 또는 파일 생성·이름 변경·삭제 작업.
- **Graph 섹션** 커밋 상세 및 **Stashes 섹션** 상세 파일 목록의 우클릭 경로 복사 메뉴 (단, `Shift+클릭`/더블클릭으로 고정 **Diff 탭** 열기는 범위에 포함).

## Further Notes (기타 참고사항)

- 더블클릭 제스처는 브라우저 이벤트 순서상 `click` 2회 이후 `dblclick`이 발생하므로, 첫 번째 클릭에서 이미 열린 동일 키의 Preview 탭이 `dblclick`의 고정 승격(`pinned: true`)으로 자연스럽게 이어져 중복 탭이 생성되지 않도록 `openDiffTab`의 동일 키 매칭 우선 규칙을 엄격히 유지해야 합니다.
- 기존 컴포넌트 테스트 호환성을 위해 **Git 뷰**·**Compare 패널**에 추가되는 선택적 콜백/저장소 루트 속성은 선택(optional) 또는 안전한 기본값을 유지합니다.
