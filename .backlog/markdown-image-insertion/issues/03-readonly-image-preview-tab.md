# 03 — 폴더 트리 이미지 파일 클릭 시 읽기 전용 이미지 미리보기 탭

**Spec:** [spec.md](../spec.md)

**What to build:** 사용자가 **탐색기 뷰**의 **폴더 트리**에서 이미지 파일(`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.avif`)을 클릭하거나 컨텍스트 메뉴로 열 때, 바이너리 파일이 UTF-8 텍스트로 읽혀 깨지거나 자동 저장으로 손상되는 일을 막고 **문서 편집기** 내에 읽기 전용 이미지 미리보기 탭으로 표시합니다. **탭 바** 전환·이동·복제, **화면 분할 모드**(`좌우 분할`, `상하 분할`), 파일 이름 변경·삭제·외부 변경 감지와 일관되게 연동하고 `CONTEXT.md` 도메인 용어집을 최신화합니다.

**Blocked by:** 01-local-image-protocol-and-rendering

**Status:** resolved

- [x] **폴더 트리**에서 지원 이미지 확장자 파일을 열면 UTF-8 `readFile`을 호출하지 않고 읽기 전용 이미지 **문서 버퍼**로 탭이 열리며, **문서 편집기** 본문에 `wiki-asset:` 기반 반응형 이미지 미리보기 뷰가 표시됩니다.
- [x] 읽기 전용 이미지 탭에서는 **에디터 헤더**의 텍스트용 **에디터 모드** 전환기(`Raw`·`위지윅`·`Preview`·`Split` 및 모드 전환 단축키)와 저장 버튼(`Ctrl+S` 포함)이 비활성화(또는 읽기 전용 상태 표시)되며, 자동 저장 타이머·미저장 닫기 확인 다이얼로그·외부 변경 시 UTF-8 텍스트 비교 대상에서 제외되어 원본 바이너리 파일이 절대 텍스트로 덮어써지지 않습니다.
- [x] 이미지 탭도 일반 탭과 동일하게 **탭 바** 활성화·닫기, 다른 **편집기 영역**으로의 이동·복제 및 **화면 분할 모드**(`좌우 분할`, `상하 분할`) 배치를 지원하여 마크다운 문서와 이미지를 나란히 띄워 비교할 수 있습니다.
- [x] **폴더 트리**에서 열린 이미지 파일(또는 상위 폴더)의 이름을 변경하면 열린 이미지 탭의 제목·경로·표시 URL이 즉시 갱신되고, 삭제되거나 외부에서 제거되면 탭이 자동으로 닫히며, 외부에서 이미지 파일이 수정되면 미리보기 URL 캐시가 갱신됩니다.
- [x] `CONTEXT.md` 도메인 용어집에 마크다운 이미지 지원 및 읽기 전용 이미지 미리보기 동작이 반영됩니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.

## Comments

- Commits: `d7cbf19`, `1415e0c`, `c0d5ba7`
- Verification: `npm run typecheck`, `npm test -- --maxWorkers=2` (`43 passed (43)`, `317 passed (317)`), `npm run build` passed after final commit `c0d5ba7`; parallel `/code-review` converged cleanly in 3 rounds with 0 Spec findings and 0 Standards findings.
