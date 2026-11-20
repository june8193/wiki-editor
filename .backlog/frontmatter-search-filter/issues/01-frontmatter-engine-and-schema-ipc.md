# 01 — 공용 YAML 프론트매터 비파괴 엔진 및 워크스페이스 스키마 서비스·IPC

**Spec:** [spec.md](../spec.md)

**What to build:** 표준 YAML 프론트매터(`--- ... ---`)를 파싱·검증·비파괴 직렬화하는 공용 엔진(6종 필드 타입, 미정의 키·주석·복잡 YAML·줄바꿈 보존, 소프트 경고)과 워크스페이스 루트 `.wiki-editor/frontmatter.json`을 관리하는 메인 프로세스 스키마 서비스·세션 격리 IPC·프리로드 브리지를 구축합니다.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 공용 프론트매터 엔진이 문서 최상단의 표준 YAML 블록(`---` 시작, `---` 또는 `...` 닫힘)만 인식하고(UTF-8 BOM·CRLF/LF 지원, 본문 중간 `---` 수평선 미오인), `body`와 1-기반 `bodyStartLine`을 정확히 분리·반환합니다.
- [ ] 스키마 기반 6종 타입(`text`, `number`, `boolean`, `date`, `select`, `multi-select`)의 파싱과 비파괴 직렬화를 지원하며, 필드 수정·추가·제거 시 스키마 미정의 키, YAML 주석, 중첩/복잡 YAML 값, 기존 줄바꿈 스타일(CRLF/LF)이 손실 없이 보존됩니다.
- [ ] 유효성 검증이 필수 누락(`required-missing`), 허용 외 옵션(`disallowed-option`, `allowCustom` 반영), 타입 불일치(`type-mismatch`), 실존 `YYYY-MM-DD` 날짜 형식 위반(`invalid-date-format`), YAML 구문 오류(`yaml-syntax-error`)를 구조화된 비차단 소프트 경고로 반환하고 문법 오류 원문을 덮어쓰지 않도록 보호합니다.
- [ ] 워크스페이스 스키마 서비스가 루트 내부 `.wiki-editor/frontmatter.json`만 경로 보안 검증 하에 읽고 원자적으로 저장하며, 파일 부재 시 오류가 아닌 `{ exists: false, schema: null }`을 반환하고 `'스키마 생성'` 호출 시 기존 파일이 없을 때 기본 Jira형 스타터 템플릿으로 원자적 초기화를 수행합니다.
- [ ] 스키마 저장 및 로드 시 `version: 1`, 유효 필드 타입, 중복 키 금지, 필수 라벨/옵션 규칙을 엄격 검증하고, 잘못된 JSON/스키마를 만나도 크래시 없이 명확한 오류 응답을 반환합니다.
- [ ] 다중 **메인 창** 환경에서 스키마 조회·생성·저장·변경 이벤트 IPC가 호출자 세션의 워크스페이스로 격리 라우팅되고 프리로드 브리지를 통해 노출되며, `.wiki-editor/frontmatter.json` 외부 변경 감지 시 최신 스키마가 재로드됩니다.
- [ ] 메인 프로세스 프론트매터 스키마·검색 서비스 및 세션 IPC 통합 테스트 심이 위 동작들을 검증하며, `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.
