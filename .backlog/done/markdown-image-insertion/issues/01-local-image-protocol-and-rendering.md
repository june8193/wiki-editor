# 01 — 로컬 에셋 프로토콜 및 전 에디터 모드 마크다운 이미지 렌더링·왕복

**Spec:** [spec.md](../spec.md)

**What to build:** Electron 메인 프로세스에 열린 워크스페이스 보안 경계를 강제하는 전용 로컬 에셋 프로토콜(`wiki-asset:`)을 등록하고, Preview·Split 렌더러와 `@tiptap/extension-image` 기반 **위지윅** 에디터에 활성 문서 기준 상대 경로 이미지 해석을 연결합니다. 사용자가 마크다운에 `![alt](./assets/pic.png)`, `![alt](../shared/diagram.svg)`, 또는 `![alt](https://...)` 구문을 작성하면 **Raw**·**위지윅**·**Preview**·**Split** 전 **에디터 모드**에서 반응형(`max-width: 100%`)으로 렌더링되고, 모드 전환 왕복 및 **위지윅** 내부 복사·붙여넣기 후에도 원본 마크다운 경로가 무손실 보존되는 엔드투엔드 경로를 완결합니다.

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 지원 이미지 확장자(`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.avif`) 및 MIME 판별 규칙과 함께 `wiki-asset:` 커스텀 프로토콜이 등록되어, 열린 워크스페이스 내부의 유효한 이미지 파일만 정확한 `Content-Type`과 `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` 헤더로 응답하고 워크스페이스 미오픈·상위 경로(`..`) 탈출·외부 심볼릭 링크·시스템 폴더(`.git`, `node_modules` 등)·비이미지 파일 요청은 차단합니다.
- [x] **Preview** 및 **Split** 모드에서 현재 문서 경로 기준 상대 경로 이미지(`./assets/...`, `../...`, 공백·괄호 인코딩 경로 포함)는 새니타이즈 단계 이후 `wiki-asset:` 표시 URL로 변환되어 렌더링되고, 외부 `http`/`https` 이미지는 그대로 표시되며, `javascript:`·`data:text/html`·`<img onerror>` 등 위험 입력은 기존과 동일하게 차단됩니다.
- [x] **위지윅** 모드에 이미지 노드 확장이 등록되어 로컬 상대 경로 및 외부 `http`/`https` 이미지가 모두 표시되며, ProseMirror 노드 상태와 `getMarkdown()` 직렬화 및 **위지윅** 내부 이미지 복사·붙여넣기에서는 `wiki-asset:`이 아닌 원본 마크다운 상대 경로(`![alt](./assets/...)`)가 무손실 보존됩니다.
- [x] **위지윅**·**Preview**·**Split** 본문 내 이미지에 `max-width: 100%; height: auto` 반응형 스타일이 적용되어 큰 이미지가 에디터 가로 폭을 넘치지 않습니다.
- [x] **문서 목차** 헤딩 추출 시 이미지가 포함된 헤딩의 `alt` 텍스트 보존 등 기존 마크다운·목차 동작이 회귀 없이 유지됩니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.

## Comments

- Commits: `19c6542`, `71ca142`, `dff41f8`, `7ec9e53`, `9a8d753`, `5e9f73f`
- Verification: `npm run typecheck`, `npm test -- --maxWorkers=2` (`42 passed (42)`, `291 passed (291)`), `npm run build` passed after final commit `5e9f73f`; 5 rounds of parallel `/code-review` converged with 0 hard Standards violations, and Round 5's linked-image heading Spec regression + minor decode helper duplication were fixed and verified in `5e9f73f`.
