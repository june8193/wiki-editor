# 05 — 프론트매터 필터·정렬·커스텀 값 수집 엔진 및 메인 프로세스 워크스페이스 검색 IPC 확장

**Spec:** [spec.md](../spec.md)

**What to build:** 프론트매터 조건 평가(조건 간 AND, 6종 타입별 표준 실용 연산자), 스키마 기반 정렬(`select` 옵션 정의 순서 우선, 빈 값 후순위), `allowCustom` 필드 워크스페이스 실사용 값 수집 엔진을 구축하고, 메인 프로세스 워크스페이스 검색 서비스와 세션 격리 IPC·프리로드 브리지를 확장해 속성 단독 조회 및 본문 검색 결합을 엔드투엔드로 동작하게 만듭니다.

**Blocked by:** `01-frontmatter-engine-and-schema-ipc`

**Status:** resolved

- [x] 공용 필터 엔진이 서로 다른 필드 조건 간 AND 결합과 모든 표준 실용 연산자(`select`: `in`/`not-in`/`is-empty`, `multi-select`: `all-of`/`any-of`/`none-of`/`is-empty`, `text`: `contains` 대소문자 무시/`equals`/`is-empty`, `number`·`date`: `equals`/`gte`/`lte`/`between`/`is-empty`, `boolean`: `equals`/`is-empty`)를 정확하게 평가합니다.
- [x] 워크스페이스 검색 서비스가 프론트매터 조건이 1개 이상일 때 텍스트 검색어가 비어 있어도 속성 단독 필터링 결과를 반환하고, 텍스트 검색어가 함께 주어지면 속성 조건과 파일명·본문 텍스트 검색(`Aa`/`ab`/`.*`)의 교집합 결과를 반환합니다.
- [x] 정렬 엔진이 기본 경로순(`path`)과 스키마 필드 오름/내림차순을 모두 지원하며, `select` 필드는 스키마 `options` 선언 순서를 우선 비교하고 빈 값/미지정 값은 오름·내림차순 모두 항상 후순위에 배치합니다(동률 시 `relativePath` 오름차순).
- [x] 각 일치 파일 결과에 요약 프론트매터 값(`frontmatterSummary`)이 포함되며, 워크스페이스 커스텀 값 수집 IPC가 `allowCustom` `multi-select` 필드들에 대해 스키마 옵션과 문서 내 실사용 커스텀 값을 중복 없이 정렬해 반환합니다.
- [x] 프론트매터 필터링 및 값 수집이 현재 **메인 창** 세션의 미저장 열린 **문서 버퍼**(소속 **보조 창** 편집분 포함)를 디스크보다 우선 반영하고, `.wiki-editor/`·비마크다운/바이너리·`2MB` 초과·탈출/순환 심볼릭 링크·`config.json` 버퍼를 제외하며, 타 **메인 창** 세션과 격리되고 후속 요청 시 이전 스캔을 취소합니다.
- [x] 메인 프로세스 프론트매터 스키마·검색 서비스 및 세션 IPC 통합 테스트 심이 위 동작들을 검증하며, `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.
