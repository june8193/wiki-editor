# wiki-editor

Lightweight high-performance Markdown desktop wiki editor for Windows.

## 시작하기

### 의존성 설치
```bash
npm install
```

### 개발 모드 실행
```bash
npm run dev
```

### 실행 파일(.exe) 빌드
```bash
npm run build:unpack
```
빌드 완료 후 `dist/win-unpacked/wiki-editor.exe`를 바로 실행할 수 있습니다.

#### 사내망/프록시 환경에서 TLS 오류가 발생하는 경우

사내 보안 프록시(자체 서명 인증서) 환경에서 `npm install`이나 `npm run build:unpack` 실행 시 TLS 인증서 검증 오류가 발생하면, 아래와 같이 `NODE_TLS_REJECT_UNAUTHORIZED=0`을 임시로 설정해 빌드할 수 있습니다.

- **PowerShell**
  ```powershell
  $env:NODE_TLS_REJECT_UNAUTHORIZED="0"
  npm run build:unpack
  ```
- **CMD**
  ```cmd
  set NODE_TLS_REJECT_UNAUTHORIZED=0
  npm run build:unpack
  ```
- **Bash (Git Bash 등)**
  ```bash
  NODE_TLS_REJECT_UNAUTHORIZED=0 npm run build:unpack
  ```

> **주의:** `NODE_TLS_REJECT_UNAUTHORIZED=0`은 TLS 인증서 검증을 비활성화하므로 신뢰할 수 있는 사내망 환경에서만 임시로 사용하세요. 사내 루트 CA 인증서(`.pem`) 파일이 있다면 `NODE_EXTRA_CA_CERTS=<인증서_경로>` 환경 변수를 사용하는 것이 더 안전합니다.

## 사용자 매뉴얼

단축키 및 전체 기능 사용법은 [docs/manual.md](docs/manual.md)에서 확인할 수 있으며, 앱 내 상단 메뉴 `Help > 사용자 매뉴얼`에서도 바로 열람할 수 있습니다.
