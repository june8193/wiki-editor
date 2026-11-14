# 04 — 3모드 마크다운 에디터(Raw·Preview·위지윅) 및 표(행·열 추가/삭제) 편집

Spec: [spec.md](../spec.md)
Type: task
Blocked by: 03-multi-tab-and-split-pane-layout
Status: ready-for-agent

**What to build:**
각 탭마다 `Raw text`, `Preview`, `위지윅(WYSIWYG)` 3가지 모드를 상단 토글/단축키로 자유롭게 전환(Split View에서 좌측 Raw + 우측 Preview 동시 보기 가능)할 수 있는 마크다운 에디터/뷰어 엔진과, 마크다운 표(Table) 삽입 및 행/열 추가·삭제 기능을 구현합니다.

## Acceptance Criteria

- [ ] 각 탭 상단 모드 스위처(`Raw` | `위지윅` | `Preview`) 및 단축키로 즉시 전환할 수 있으며, 3모드 모두 단일 `.md` 문자열(Document Buffer)을 기준으로 동작해 모드를 왕복 전환해도 마크다운 문서 구조가 손상되지 않습니다.
- [ ] **Raw 모드**: CodeMirror 6 기반 가상 스크롤 에디터로 구현되어 10,000줄 이상 대용량 문서도 부드럽게 편집되며 마크다운 구문 강조를 지원합니다.
- [ ] **Preview 모드**: `unified`/`remark-gfm`/`rehype-sanitize` 파이프라인으로 GFM 마크다운(표, 체크리스트, 코드블록, 인용, 링크 등)을 라이트/다크 테마에 맞춰 안전하게 렌더링합니다.
- [ ] **위지윅 모드**: ProseMirror 기반(Milkdown 또는 TipTap Markdown — 구현 착수 시 표/마크다운 라운드트립 정확도를 기준으로 최종 선택)으로 직관적 리치 텍스트 편집 및 툴바 액션을 제공합니다.
- [ ] **표(Table) 편집**: 위지윅 모드에서는 표 셀 컨텍스트/플로팅 툴바를 통해 **행 위/아래 추가, 열 좌/우 추가, 현재 행/열 삭제, 표 삽입**이 가능하고, Raw 모드에서도 `TableMarkdownManipulator` 유틸과 커맨드/툴바로 동일한 행·열 추가/삭제 및 마크다운 표 정렬이 동작합니다.
- [ ] 모드 전환 라운드트립, XSS sanitization, 표 행/열 추가·삭제 단위 테스트 및 UI 통합 테스트가 모두 통과합니다.
