# 02 — 클립보드 붙여넣기 및 파일·폴더 트리 드래그 앤 드롭 이미지 삽입

**Spec:** [spec.md](../spec.md)

**What to build:** 워크스페이스 파일 시스템 계층과 IPC·preload 브리지에 깊은 단일 이미지 수집(Ingestion) 계약을 구축하고, **Raw**(단일 및 `Split` 좌측 포함)와 **위지윅** 에디터에 클립보드 이미지 붙여넣기(`Ctrl+V`) 및 OS 파일 탐색기·왼쪽 사이드바 **폴더 트리** 드래그 앤 드롭 핸들러를 연결합니다. 붙여넣은 캡처 이미지와 외부 드롭 파일은 현재 문서 하위 `assets/` 폴더에 자동 저장 후 `./assets/<파일명>`으로 삽입되고, 워크스페이스 내부 이미지는 중복 복사 없이 상대 경로로 연결되며 즉시 렌더링되는 엔드투엔드 경로를 완결합니다.

**Blocked by:** 01-local-image-protocol-and-rendering

**Status:** resolved

- [x] 워크스페이스 이미지 수집 모듈이 현재 문서 경로를 검증하고, 클립보드 비트맵은 `<문서폴더>/assets/<문서명>-YYYYMMDD-HHmmss.<확장자>`로, 워크스페이스 외부 이미지 파일은 원본 파일명을 유지해 `<문서폴더>/assets/`에 배타적 생성(`wx`)으로 저장하며, 동명 파일 존재 시 `-1`, `-2` 접미사를 자동 부여하고 `assets/` 폴더가 없으면 자동 생성합니다.
- [x] 드롭된 이미지 파일의 실경로가 현재 열린 워크스페이스 루트 내부(무시 대상 시스템 폴더 제외)에 속하면, 파일을 중복 복사하지 않고 현재 마크다운 문서 기준 POSIX 상대 경로(공백·괄호 포함 시 CommonMark 안전 인코딩 적용)를 반환합니다.
- [x] **Raw** 및 **위지윅** 모드의 마크다운 문서에서 클립보드 이미지 붙여넣기(`Ctrl+V`) 시 이미지가 수집되어 현재 커서/선택 위치에 `![alt](경로)`로 즉시 삽입되며, 클립보드에 일반 텍스트(`text/plain`)가 함께 있는 텍스트·코드·표 붙여넣기와 `config.json` 등 비마크다운 버퍼에서는 기존 붙여넣기 동작이 그대로 유지됩니다.
- [x] OS 파일 탐색기 및 앱 내 **폴더 트리**(이미지 항목 드래그 지원, **편집 공간** 탭 분할 드롭존과 비간섭)에서 단일 또는 다중 이미지 파일을 **Raw**·**위지윅** 에디터로 드롭하면 순서대로 모두 삽입되며, **위지윅**·**Preview**·**Split**에서 즉시 렌더링됩니다.
- [x] 비이미지 파일 드롭이나 에디터 외부 창 영역으로의 파일 드롭 시 Electron 창이 파일 URL로 이동(네비게이션)하지 않도록 안전하게 차단되며, 수집 실패 시 **오류 배너**로 사용자에게 알립니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.

## Comments

- Commits: `939c110`, `ed641b8`, `a1a81f8`, `1887771`
- Verification: `npm run typecheck`, `npm test -- --maxWorkers=2` (`43 passed (43)`, `309 passed (309)`), `npm run build` passed after final commit `1887771`; parallel `/code-review` converged cleanly in 4 rounds with 0 Spec findings and 0 hard Standards violations.
