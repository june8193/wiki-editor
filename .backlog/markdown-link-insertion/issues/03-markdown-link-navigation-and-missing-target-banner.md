# 03 — Preview 클릭 및 Raw·위지윅 Ctrl+클릭 섹션·파일 이동과 깨진 링크 안내

**Spec:** [spec.md](../spec.md)

**What to build:** **Preview** 모드의 일반 클릭과 **Raw**·**위지윅** 모드의 `Ctrl+클릭`(`Cmd+클릭`)으로 같은 문서 `#섹션` 스크롤 및 다른 마크다운 파일 탭 열기를 지원하고, 존재하지 않는 파일이나 `#섹션` 클릭 시 새 파일을 생성하지 않고 상단 **오류 배너**로 안내합니다.

**Blocked by:** 02-workspace-file-link-autocomplete

**Status:** resolved

- [x] **Preview** 모드에서는 링크 일반 클릭 시, **Raw** 및 **위지윅** 모드에서는 링크 위 `Ctrl+클릭`(macOS `Meta+클릭`) 시에만 문서·섹션 이동이 실행되며, **Raw**·**위지윅**에서의 일반 클릭은 기존 텍스트 편집 커서 이동만 수행하고 Electron 창 내비게이션은 항상 차단됩니다.
- [x] 외부 URL(`http://`, `https://`, `mailto:`) 클릭 또는 `Ctrl+클릭` 시에는 앱 내 문서 이동이나 오류 배너를 발생시키지 않고 창 내비게이션 차단을 유지합니다.
- [x] 같은 문서 내 `#슬러그` 링크를 통해 이동하면(퍼센트 인코딩된 한글·특수문자 슬러그 포함), 클릭이 일어난 **편집기 영역**의 현재 **에디터 모드**(**Raw** 헤딩 줄 이동·스크롤, **위지윅** 헤딩 위치 스크롤, **Preview** 헤딩 앵커 스크롤)로 즉시 이동합니다.
- [x] 상대 경로 마크다운 파일 링크(`./파일.md`, `../폴더/파일.md`, 퍼센트 인코딩된 파일명 포함)를 통해 이동하면 현재 문서 경로를 기준으로 대상을 해석하여 클릭이 발생한 **편집기 영역**(단일 및 좌우·상하 **화면 분할 모드** 모두 해당 영역 기준)에서 해당 파일 탭을 열거나 이미 열린 탭을 활성화합니다(수동 작성된 `./파일.md#슬러그` 형태인 경우 파일 탭을 연 뒤 해당 섹션까지 스크롤).
- [x] 현재 문서에 존재하지 않는 `#슬러그`, 존재하지 않는 마크다운 파일, 또는 워크스페이스 루트 밖 경로(`../../outside.md` 등)를 가리키는 링크를 클릭하면 새 파일을 생성하지 않고 상단 **오류 배너**(`role="alert"`)에 대상을 찾을 수 없다는 안내 메시지를 표시합니다(대상 파일은 존재하나 함께 적힌 `#슬러그`만 없는 경우 파일 탭은 연 채 **오류 배너** 표시).
- [x] 순수 링크 대상 해석 단위 테스트와 `<App />` 통합 테스트(**Preview** 클릭, **Raw**·**위지윅** `Ctrl+클릭`, 분할 영역 탭 열기, 없는 파일·없는 섹션 **오류 배너** 및 파일 미생성 검증)가 모두 통과합니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.

## Comments

- **구현 및 리팩토링 커밋 (`3da7d52..HEAD`):**
  - `7bf2495` — feat(editor): add markdown link navigation and missing target banner
  - `56ffb61` — fix(editor): guard Electron navigation, ignore blank Raw clicks, and simplify link helpers
  - `a82404f` — test(app): extend timeout for 25-tab mount stress test under full suite
  - `2787c89` — refactor(editor): bundle heading scroll target and unify error reporting
  - `0edbd0a` — refactor(editor): separate link syntax scanner, click policy, and path resolution
  - `8027abe` — fix(editor): decode section slugs once and align parameter name
  - `5ffe13a` — refactor(editor): extract horizontal whitespace skip helper in link syntax scanner
  - `d2ae5da` — test(git): increase integration test timeouts for full-suite worker concurrency
  - `dd9c097` — fix(editor): reject non-markdown relative links, deduplicate helpers, and extract link nav hook
- **최종 검증 (`dd9c097`):**
  - `npm run typecheck` 통과 (exit 0)
  - `npm test` 통과 (44개 테스트 파일, 309개 테스트 모두 통과, 74.70s)
  - `npm run build` 통과 (exit 0, 4.15s)
- **병렬 `/code-review` (`3da7d52..HEAD`):**
  - Standards Review: Hard Violations 0건 (Non-blocking Nits 4건)
  - Spec Review: Findings 0건 (Violations/Gaps 0건)
