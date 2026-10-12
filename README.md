# Claude 사용량 위젯

아이폰 홈 화면·잠금 화면에서 Claude 구독 사용량(5시간 세션 한도, 주간 한도)을 보여 주는 [Scriptable](https://scriptable.app) 위젯입니다.

![미리보기](docs/previews/preview-light.png)

- **설치 방법:** [설치안내.md](설치안내.md)
- **위젯 스크립트:** [claude-usage-widget.js](claude-usage-widget.js) (외부 라이브러리 없이 파일 1개로 동작)

## 구성

| 경로 | 내용 |
| --- | --- |
| `claude-usage-widget.js` | Scriptable에 붙여넣는 위젯 스크립트 |
| `설치안내.md` | 아이폰 설치·설정 안내 |
| `docs/previews/` | 가짜 데이터로 만든 위젯 미리보기 이미지 |
| `dev/` | 개발용 도구: 브라우저에서 Scriptable을 흉내 내 스크립트를 실행하고, 미리보기 이미지와 상황별 동작 점검 결과를 만든다 |

## 고칠 때 참고

- claude.ai 주소가 바뀌면 스크립트 맨 위 **API 설정**을, 응답 형식이 바뀌면 `parseUsage()`를 고친다.
- 고친 뒤에는 `cd dev && npm install && npm run preview`로 상황별 점검(정상, 사용량 높음, 인터넷 끊김, 로그인 만료, 접속 차단, 형식 변경, 앱 안 로그인 방식 등)과 미리보기 이미지를 다시 만든다.
