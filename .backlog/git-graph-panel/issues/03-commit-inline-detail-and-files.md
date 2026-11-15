# 03 — Graph 커밋 클릭 시 인라인 상세 정보·변경 파일 트리 펼침 및 해시 복사

**Spec:** [spec.md](../spec.md)

**What to build:** **Graph 섹션**에서 커밋 행을 클릭하면 해당 행 바로 아래에 인라인 상세 영역이 펼쳐져 전체 커밋 메시지(제목·본문), 작성자·이메일·커밋 일시, 단축 해시와 `해시 복사` 버튼, 해당 커밋에서 변경된 파일 목록(`A` / `M` / `D` / `R` 배지 및 이름 변경 경로)을 표시합니다. 다시 클릭하면 접히며 조회 전용으로 동작합니다.

**Blocked by:** 02-commit-graph-and-branch-filter

**Status:** resolved

- [x] 공유 스키마, `git:commit-detail` IPC 채널(활성 워크스페이스 검증 포함), Preload `window.wikiApi.git.commitDetail` 브리지가 연결되고 경계 단위 테스트가 있습니다.
- [x] Git 서비스의 커밋 상세 조회가 유효한 16진수 커밋 해시 형식만 허용(옵션 주입 차단)하며, 일반 커밋·초기 루트 커밋(`--root` 빈 트리 대비 전체 `A` 산출)·머지 커밋(`--first-parent` 첫 번째 부모 대비 병합 변경 파일 산출)·이름 변경 파일(`-M` `origPath → path`)·빈 커밋(`--allow-empty`)을 정확히 파싱함을 격리된 임시 Git 저장소 통합 테스트로 검증합니다.
- [x] **Graph 섹션**에서 커밋 행(`aria-expanded`)을 클릭하면 해당 커밋 바로 아래에 인라인 상세 영역이 펼쳐지고, 같은 커밋 행을 다시 클릭하면 접힙니다(워크스페이스 전환이나 필터 변경 시 이전 확장 상태 안전 정리 포함).
- [x] 인라인 상세 영역에 작성자·커밋 일시·단축 해시·커밋 본문(있는 경우)과 변경 파일 목록(`A` / `M` / `D` / `R` 상태 배지 및 경로, 변경 파일이 없으면 빈 안내 문구)이 표시됩니다.
- [x] 인라인 상세 영역의 `해시 복사` 버튼을 누르면 전체 커밋 해시가 클립보드에 복사됩니다(커밋 체크아웃·리셋·브랜치 생성 등 저장소 변형 액션은 두지 않음).
- [x] `<App />` 통합 테스트가 커밋 클릭 시 인라인 상세 및 변경 파일 목록 펼침/접힘과 `해시 복사` 동작을 검증합니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.

## Comments

- Commits: `67038d3`, `9e7261d`, `fb7e348`
- Verification: `npm run typecheck`, `npm test` (`41 passed (41)`, `265 passed (265)`), `npm run build` passed; parallel `/code-review` reached 0 Spec findings and 0 hard Standards violations after 3 iterations (`GitCommitDetail.parents` Speculative Generality heuristic suppressed as explicitly mandated by `spec.md` L103).
