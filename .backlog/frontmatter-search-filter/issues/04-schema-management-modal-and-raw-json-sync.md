# 04 — 워크스페이스 프론트매터 스키마 관리 모달 및 Raw JSON 편집 연동

**Spec:** [spec.md](../spec.md)

**What to build:** 워크스페이스 `.wiki-editor/frontmatter.json`을 앱 내 GUI로 편집하는 **스키마 관리 모달**과 Raw JSON 탭 직접 편집 연동을 구축합니다. **문서 속성 섹션**에서 모달을 열어 필드·타입·옵션·색상·순서를 관리하거나 Raw JSON 탭으로 열어 저장하면 **메인 창**과 소속 **보조 창** 전체의 스키마와 유효성 검증이 즉시 갱신되도록 만듭니다.

**Blocked by:** `03-right-sidebar-properties-accordion`

**Status:** ready-for-agent

- [ ] **문서 속성 섹션** 헤더의 `⚙`(스키마 관리) 버튼 및 스키마 미생성/오류 안내에서 **스키마 관리 모달**을 여닫을 수 있으며, 모달이 열려 있는 동안 에디터·전역 단축키가 억제되고 `Esc` 및 닫기 버튼으로 닫을 수 있습니다.
- [ ] 모달에서 6종 타입 필드의 추가·수정·삭제·순서 이동, `required`·`placeholder`·`showInSearchBadge` 설정, `select`/`multi-select` 선택지(옵션) 추가·삭제·순서 변경·배지 색상 지정 및 `multi-select`의 `allowCustom` 토글이 동작합니다.
- [ ] 중복 키, 유효하지 않은 키, 빈 라벨/옵션 등 잘못된 입력은 저장 전 인라인 검증 메시지로 안내되고, 유효한 변경을 저장하면 `.wiki-editor/frontmatter.json`에 원자적으로 기록되어 현재 **메인 창**과 소속 **보조 창**의 **문서 속성 섹션** 폼·유효성 경고가 즉시 갱신됩니다.
- [ ] 모달의 `'JSON 파일로 열기'` 액션이 `.wiki-editor/frontmatter.json`을 활성 **편집기 영역**의 일반 Raw JSON 탭으로 열고, 해당 탭에서 JSON을 수정·저장하거나 외부 파일 변경이 감지되면 스키마가 자동 재로드·검증되어 앱 전체에 반영됩니다.
- [ ] Raw JSON 탭이나 외부에서 `.wiki-editor/frontmatter.json`이 잘못된 JSON/스키마로 저장되어도 크래시 없이 명확한 스키마 오류 안내 및 복구 진입을 제공하며, 열려 있는 마크다운 문서의 프론트매터 원문은 보존됩니다.
- [ ] `<App />` 통합 · 멀티윈도우 및 `<DocumentEditor />` 공개 UI 테스트 심이 위 동작들을 검증하며, `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.
