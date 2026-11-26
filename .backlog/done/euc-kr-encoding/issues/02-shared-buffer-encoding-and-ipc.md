# 02 — 공유 문서 버퍼 인코딩 상태, IPC 및 자동 저장 손실 보호

**Spec:** [spec.md](../spec.md)

**What to build:** **문서 버퍼**에 `encoding`·`savedEncoding` 상태와 미저장 불변식을 도입하고, **메인 창**·**보조 창** 간 공유 버퍼 허브와 IPC/Preload 계층에서 인코딩 변경(미저장 표시)·재열기(Reopen)·손실 확인 저장·자동 저장 보류·외부 변경 재조정을 E2E로 동작하게 합니다.

**Blocked by:** 01-text-encoding-codec-and-workspace-fs

**Status:** resolved

- [ ] **문서 버퍼**가 `encoding`과 `savedEncoding`(기본 `'utf-8'`)을 보유하며, 텍스트 버퍼의 `isDirty`가 `content !== savedContent || encoding !== savedEncoding` 불변식을 따른다.
- [ ] `setEncoding` 호출 시 메모리 본문은 유지한 채 대상 인코딩만 변경되어 `isDirty`가 갱신되고, 저장 전 원래 인코딩으로 되돌리면(본문 미변경 시) `isDirty`가 `false`로 복원된다.
- [ ] `reopenWithEncoding` 호출 시 디스크 원본 바이트를 지정 인코딩으로 다시 디코딩해 `content`·`savedContent`·`encoding`·`savedEncoding`을 갱신하고 `isDirty`를 초기화한다.
- [ ] `config.json`, `.wiki-editor/frontmatter.json`, 이미지 버퍼는 항상 `'utf-8'`로 고정되며 인코딩 변경·재열기 요청을 거부한다.
- [ ] `saveBuffer`가 `allowLossy` 옵션을 지원해, 수동 저장 시 EUC-KR 표현 불가 문자가 있으면 디스크를 변경하지 않고 구조화된 손실 정보(`unencodableChars`)를 반환하며, `allowLossy: true` 전달 시 `?` 대체 저장 후 `savedEncoding`을 갱신한다.
- [ ] 자동 저장은 항상 `allowLossy: false`로 동작하며, 표현 불가 문자로 실패 시 무한 재시도를 중단하고 `save-error` 이벤트를 발행한다(이후 본문/인코딩 변경 시 재시도 가능).
- [ ] 깨끗한(`!isDirty`) 파일이 디스크에서 외부 수정되면 내용과 함께 인코딩도 재감지하여 동기화하며, IPC·Preload·렌더러 버퍼 동기화 클라이언트 계약을 포함한 통합 테스트가 통과한다.
