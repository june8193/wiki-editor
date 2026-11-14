# 05 — Mermaid 다이어그램 렌더링 및 하이브리드 목차(TOC)·헤딩 자동 넘버링

Spec: [spec.md](../spec.md)
Type: task
Blocked by: 04-three-mode-markdown-editor-and-table
Status: resolved

**What to build:**
마크다운 문서 내 `mermaid` 코드 블록을 Preview 및 위지윅 모드에서 디바운스·캐싱 기반으로 빠르게 다이어그램으로 렌더링하고, 하이브리드 방식의 자동 목차 생성(사이드바 Outline 패널 + `/toc` 본문 목차 삽입) 및 계층형 헤딩 자동 넘버링(`1.`, `1.1.`, 렌더링 표시 및 명시적 본문 동기화)을 구현합니다.

## Acceptance Criteria

- [x] **Mermaid 렌더링 및 경량화**: ` ```mermaid ` 코드 블록을 감지해 Preview와 위지윅 모드에서 SVG 다이어그램으로 렌더링하며, 앱의 라이트/다크 테마 전환 시 Mermaid 테마도 자동 연동됩니다.
- [x] **성능 캐시 & 오류 격리**: 타이핑 중 입력 디바운싱과 코드 해시 캐싱으로 변경되지 않은 Mermaid 블록은 재렌더링하지 않으며, 문법 오류가 있는 블록은 앱 크래시 없이 해당 블록 영역에 명확한 오류 안내와 원본 코드를 표시합니다.
- [x] **사이드바 Outline(목차) 자동 생성**: 현재 활성 문서의 헤딩(`#` ~ `######`)을 실시간 파싱(코드 펜스 블록 내부 `#` 제외)하여 사이드바 Outline 트리를 구성하고, 항목 클릭 시 Raw/Preview/위지윅 에디터의 해당 위치로 스크롤 이동합니다.
- [x] **하이브리드 자동 넘버링**:
  - 기본 동작: `config.json`의 `showHeadingNumbers` 옵션이 켜져 있을 때 원본 `.md` 텍스트를 변경하지 않고 Outline과 Preview/위지윅 화면에만 계층 번호(`1.`, `1.1.`, ...)를 동적 표시합니다.
  - 명시적 텍스트 액션: 사용자가 "본문에 목차(`/toc`) 삽입" 또는 "본문 헤딩 번호 쓰기/제거" 명령을 실행하면 코드 블록 밖의 헤딩에만 안전하게 번호/목차 블록을 삽입·갱신합니다.
- [x] `MarkdownTocEngine`(코드 블록 무시, 계층 번호 생성/제거, 목차 마크다운 생성), Mermaid 캐시/에러 처리, UI 테스트가 모두 통과합니다.

## Answer

- **구현 내용**:
  - `src/renderer/src/editor/mermaidRenderer.ts`, `src/renderer/src/components/MermaidDiagram.tsx`, `MermaidCodeBlockNodeView.tsx`: 지연 로딩 + `(theme, codeHash)` LRU 캐시 + 인플라이트 중복 제거 + 디바운싱 + DOMPurify SVG sanitize 기반 Mermaid 다이어그램 렌더링(Preview & 위지윅), 라이트/다크 테마 동기화 및 문법 오류 격리(`role="alert"` + 원본 코드 표시)
  - `src/renderer/src/editor/MarkdownTocEngine.ts`: 코드 펜스(```` ``` ```` / `~~~`) 무시 헤딩 파싱, 계층형 번호(`1.`, `1.1.`) 계산, `/toc` 및 `<!-- toc -->` 블록 생성·갱신, 안전한 본문 헤딩 번호 쓰기/제거 구현
  - `src/renderer/src/components/DocumentOutlinePanel.tsx`, `useOneShotScroll.ts`, `markdownPreview.tsx`, `wysiwygMarkdown.ts`, `SettingsPanel.tsx`: 실시간 사이드바 Outline 트리, Raw/Preview/위지윅 클릭-스크롤 이동, `showHeadingNumbers` 동적 넘버링(원본 `.md` 비오염) 및 명시적 본문 목차/번호 액션 연동
- **검증 결과**: `npm test`(23개 파일 142개 테스트), `npm run typecheck`, `npm run build` 모두 통과 (최종 커밋 `d76f41e`, 3회 `/code-review` Standards/Spec 루프 통과)
