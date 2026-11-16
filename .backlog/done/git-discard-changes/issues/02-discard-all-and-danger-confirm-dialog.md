# 02 — '전체 롤백' 일괄 취소 및 위험 강조 확인 다이얼로그

**Spec:** [spec.md](../spec.md)

**What to build:** **확인 다이얼로그**에 위험 강조(`danger`, `--danger-color` 빨간 버튼) 확인 톤을 도입하고, Git 서비스의 일괄 롤백(`git:discard-all`) 및 **Changes 섹션** `변경 사항` 헤더의 상시 `전체 ↶` 버튼을 연결합니다. `전체 ↶` 클릭 시 추적·미추적 파일 개수를 구분 안내하는 단일 위험 강조 **확인 다이얼로그**를 표시하며, 승인 시(대상 중 미저장 `●` 버퍼가 있으면 대상 한정 미저장 확인을 거친 뒤) 모든 워킹 트리 변경 복원과 미추적 파일 휴지통 이동, 열린 모든 `unstaged` **Diff 탭** 자동 닫기, **문서 버퍼**·**폴더 트리** 동기화 및 도메인 용어집 갱신을 완결합니다.

**Blocked by:** 01-single-file-discard-and-tab-sync

**Status:** resolved

- [x] **확인 다이얼로그** 상태·컴포넌트에 선택적 `confirmTone?: 'primary' | 'danger'`(기본값 `'primary'`)가 추가되어 `'danger'` 지정 시 `--danger-color` 기반 빨간 위험 강조 확인 버튼이 렌더링되며, 기존 다른 다이얼로그들은 기본 `'primary'` 스타일을 그대로 유지합니다.
- [x] 공유 `WikiGitApi.discardAll` 타입 계약, `git:discard-all` IPC 채널(활성 워크스페이스 일치 검증 포함), Preload `window.wikiApi.git.discardAll` 브리지, Git 서비스 `discardAll(workspacePath)`(모든 `M`·`D` Index 기준 복원, `U` 현재 브랜치 기준 강제 복원, `?` 휴지통 이동, `스테이지됨` 보존, 빈 변경 사항 멱등 처리)가 구현되고 Git 서비스 통합 테스트 및 IPC·Preload 경계 테스트가 통과합니다.
- [x] **Changes 섹션** `변경 사항` 헤더의 `전체 +` 왼쪽에 상시 `전체 ↶` 버튼(`aria-label` 및 `title`: `"전체 변경 사항 롤백"`)이 렌더링되고, `변경 사항` 파일이 `0`개이거나 Git 작업 실행 중일 때 비활성화되며 `스테이지됨` 헤더에는 표시되지 않습니다.
- [x] `전체 ↶` 클릭 시 분기 버튼 없이 취소와 단일 위험 강조(`confirmTone: 'danger'`) 확인 버튼(`전체 롤백`)을 가진 **확인 다이얼로그**가 열리며, 현재 `변경 사항` 구성(추적 전용 / 미추적 전용 / 추적+미추적 혼합)에 따라 추적 파일 개수(복구 불가 경고 포함)와 미추적 파일 개수(휴지통 이동 안내 포함)가 메시지에 구분 표시되고 취소 시 아무 변경도 실행되지 않습니다.
- [x] 다이얼로그 확인 승인 시 롤백 대상 파일 중 열린 미저장(`●`) **문서 버퍼**가 있으면 대상 한정 `'저장 후 진행'` / `'저장 없이 진행'` 확인을 거친 뒤 일괄 롤백이 실행되며(비대상 미저장 문서 무간섭), 완료 후 모든 대상 **문서 버퍼** 강제 디스크 동기화·삭제 탭 닫기, 두 **편집기 영역**의 모든 열린 `unstaged` **Diff 탭** 자동 닫기(`staged`·`commit` **Diff 탭** 유지), **폴더 트리** 및 **액티비티 바** 배지 갱신이 수행됩니다.
- [x] 도메인 용어집(`CONTEXT.md`)의 **Changes 섹션** 및 **확인 다이얼로그** 항목이 변경 사항 롤백 및 전체 롤백 확인 동작을 반영하도록 갱신됩니다.
- [x] `<App />` 통합 테스트가 `전체 ↶` 비활성화 조건, 추적 전용·미추적 전용·혼합 상태별 다이얼로그 문구 및 위험 강조 확인 버튼, 취소 방어, 확인 승인 시 일괄 롤백·미저장 대상 확인 연동·열린 `unstaged` **Diff 탭** 일괄 닫기를 검증하며, `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.

## Comments

- Commits: `4b7b982`, `72ff48d`, `07f1ebc`
- Verification: `npm run typecheck`, `npm test` (`65 passed (65)`, `541 passed (541)`), `npm run build` passed; parallel `/code-review` converged to 0 Spec findings and 0 Standards findings in 3 iterations.
