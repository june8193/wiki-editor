# 01 — 텍스트 인코딩 코덱 및 워크스페이스 파일·검색 연동

**Spec:** [spec.md](../spec.md)

**What to build:** UTF-8과 EUC-KR(CP949) 자동 감지·디코딩·인코딩·손실 검사 공용 코덱 모듈을 구축하고, 워크스페이스 파일 읽기/쓰기 및 **검색 패널** 본문·프론트매터 조회에 EUC-KR 자동 감지와 손실 보호 쓰기를 E2E로 연결합니다.

**Blocked by:** None — can start immediately

**Status:** resolved

- [ ] `iconv-lite`가 `devDependencies`에 추가되고(Electron 패키징 규칙인 `dependencies` = `node-pty` 단독 제약 유지), `packaging.test.ts` 및 빌드가 통과한다.
- [ ] 텍스트 인코딩 코덱·감지 API가 `utf-8` / `euc-kr` 타입, 엄격 UTF-8 검증 후 CP949 자동 감지 디코딩, 명시적 인코딩 디코딩, 그리고 멀티바이트(UTF-8/CP949) 경계 안전 바이트 절단 기능을 제공한다.
- [ ] `euc-kr` 인코딩 전 CP949 표현 불가 문자(이모지 등)를 사전 감지해 `{ count, samples }`를 산출하며(원본의 리터럴 `?`와 구분), `allowLossy` 미허용 시 손실 오류를 발생시키고 `allowLossy: true`일 때만 `?` 대체 인코딩으로 기록한다.
- [ ] 워크스페이스 파일서비스가 자동 감지 및 명시 인코딩 기반 읽기·쓰기를 지원하며, **검색 패널** 본문 검색과 **프론트매터 필터 바**·속성 조회가 EUC-KR 문서를 깨짐 없이 색인·파싱한다(기존 2MB 제한 및 바이너리 널 바이트 제외 유지).
- [ ] 코덱·감지·손실 검사 및 격리된 임시 디렉토리 기반 워크스페이스 FS/검색 테스트가 모두 통과한다.
