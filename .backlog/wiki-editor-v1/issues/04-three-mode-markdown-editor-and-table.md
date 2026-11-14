# 04 — 3모드 마크다운 에디터(Raw·Preview·위지윅) 및 표(행·열 추가/삭제) 편집

Spec: [spec.md](../spec.md)
Type: task
Blocked by: 03-multi-tab-and-split-pane-layout
Status: resolved

**What to build:**
각 탭마다 `Raw text`, `Preview`, `위지윅(WYSIWYG)` 3가지 모드를 상단 토글/단축키로 자유롭게 전환(Split View에서 좌측 Raw + 우측 Preview 동시 보기 가능)할 수 있는 마크다운 에디터/뷰어 엔진과, 마크다운 표(Table) 삽입 및 행/열 추가·삭제 기능을 구현합니다.

## Acceptance Criteria

- [x] 각 탭 상단 모드 스위처(`Raw` | `위지윅` | `Preview`) 및 단축키로 즉시 전환할 수 있으며, 3모드 모두 단일 `.md` 문자열(Document Buffer)을 기준으로 동작해 모드를 왕복 전환해도 마크다운 문서 구조가 손상되지 않습니다.
- [x] **Raw 모드**: CodeMirror 6 기반 가상 스크롤 에디터로 구현되어 10,000줄 이상 대용량 문서도 부드럽게 편집되며 마크다운 구문 강조를 지원합니다.
- [x] **Preview 모드**: `unified`/`remark-gfm`/`rehype-sanitize` 파이프라인으로 GFM 마크다운(표, 체크리스트, 코드블록, 인용, 링크 등)을 라이트/다크 테마에 맞춰 안전하게 렌더링합니다.
- [x] **위지윅 모드**: ProseMirror 기반(Milkdown 또는 TipTap Markdown — 구현 착수 시 표/마크다운 라운드트립 정확도를 기준으로 최종 선택)으로 직관적 리치 텍스트 편집 및 툴바 액션을 제공합니다.
- [x] **표(Table) 편집**: 위지윅 모드에서는 표 셀 컨텍스트/플로팅 툴바를 통해 **행 위/아래 추가, 열 좌/우 추가, 현재 행/열 삭제, 표 삽입**이 가능하고, Raw 모드에서도 `TableMarkdownManipulator` 유틸과 커맨드/툴바로 동일한 행·열 추가/삭제 및 마크다운 표 정렬이 동작합니다.
- [x] 모드 전환 라운드트립, XSS sanitization, 표 행/열 추가·삭제 단위 테스트 및 UI 통합 테스트가 모두 통과합니다.

## Answer

- **구현 내용**:
  - **위지윅 엔진 최종 선택**: `TipTap v3` (`@tiptap/react@^3.34.0` + `@tiptap/markdown@^3.34.0` + `@tiptap/extension-table*`) 채택 — React 19 호환성, 동기식 ProseMirror 표 조작, 단일 헤더 행 불변식 유지(`addTableRowBeforeSafely`, `deleteTableRowPreservingHeader`), `rehype-sanitize` 기반 XSS 보안 파이프라인 통합
  - `src/renderer/src/editor/editorModes.ts`, `DocumentEditor.tsx`: 탭별 상단 모드 스위처(`Raw` | `위지윅` | `Preview`) 및 단축키(`Ctrl+1/2/3`, `Ctrl+Shift+M`), 단일 `DocumentBuffer` 기준 무손실 모드 전환 및 Split View 이기종 모드 실시간 동기화(`config.json`/`.json`/`.txt`는 Raw 모드 고정)
  - `src/renderer/src/components/RawMarkdownEditor.tsx`, `useRawCodeMirrorEditor.ts`: CodeMirror 6 가상 스크롤, 마크다운/JSON 구문 강조, 라이트/다크 테마 연동, CRLF 줄바꿈 보존 및 커서·스크롤 복원
  - `src/renderer/src/editor/markdownSecurity.ts`, `markdownPreview.tsx`, `MarkdownPreview.tsx`: `unified` + `remark-parse` + `remark-gfm` + `remark-rehype` + `rehype-raw` + `rehype-sanitize` + `rehype-react` 파이프라인으로 안전한 GFM 렌더링 및 XSS 차단
  - `src/renderer/src/editor/TableMarkdownManipulator.ts`, `rawTableCommands.ts`, `WysiwygMarkdownEditor.tsx`, `wysiwygMarkdown.ts`: 코드 펜스 인식 GFM 표 파싱/정렬 및 Raw·위지윅 양쪽에서 표 삽입, 행 위/아래 추가, 열 좌/우 추가, 현재 행/열 삭제, 표 삭제 지원
- **검증 결과**: `npm test`(19개 파일 111개 테스트), `npm run typecheck`, `npm run build` 모두 통과 (최종 커밋 `20dd0f1`, 5회 `/code-review` Standards/Spec 루프 통과)
