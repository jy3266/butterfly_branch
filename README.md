# butterfly_branch — 나비의 가지

이미 죽어 속이 빈 나무껍질 위에, 관객이 전해 준 이야기와 마음으로 조금씩 생명이 돋아나는 인터랙티브 웹 작품입니다.

관객이 [種間水話 웹사이트](https://lobster-app-984xv.ondigitalocean.app/)(QR)에 글을 남기면 이 화면에서 다음 일이 일어납니다.

1. 빛 알갱이가 모여 빛이 되고, 그 빛이 터지며 나비 한 마리가 태어납니다.
2. 나무껍질 위에 꽃 한 송이가 피어나고, 나비와 꽃이 빛나는 선으로 이어집니다.
3. 20초 동안 선으로 그린 비가 내리고 빗소리가 들립니다.

나비를 누르면 나비가 빛으로 변해 20초 동안 빛나며, 그 나비에 담긴 글을 보여 줍니다.

## 실행

```bash
npm install
npm start          # http://localhost:8001
```

서버는 원래 웹사이트의 `/all`을 1.5초마다 확인해서 새 글을 `data/words.json`에 모두 쌓아 둡니다. 원래 서버는 점수(0/1) 칸마다 마지막 글만 남기기 때문에, 이 서버가 따로 기록을 모아 둡니다.

| 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `8001` | 이 작품을 띄울 포트 |
| `SOURCE_URL` | `https://lobster-app-984xv.ondigitalocean.app` | 관객이 글을 쓰는 원래 웹사이트 주소 |
| `POLL_MS` | `1500` | 원래 웹사이트를 확인하는 간격(ms) |

## 호스팅 (DigitalOcean App Platform)

호스팅 서버는 재시작하면 파일이 처음 상태로 돌아갑니다. 그래서 `GITHUB_TOKEN`을 넣어 두면 서버가 모인 글을 이 저장소의 **`data` 브랜치**에 자동으로 저장하고, 다시 켜질 때 그곳에서 이어받습니다. `main`이 아닌 브랜치에 저장하므로 글이 올 때마다 재배포되지는 않습니다.

| 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `GITHUB_TOKEN` | (없음) | 이 저장소의 Contents 읽기/쓰기 권한이 있는 토큰. 없으면 로컬 파일에만 저장 |
| `GITHUB_REPO` | `jy3266/butterfly_branch` | 글을 저장할 저장소 |
| `GITHUB_DATA_BRANCH` | `data` | 글을 저장할 브랜치 (없으면 `main`에서 만들어 씀) |

## 전시할 때

브라우저는 화면을 한 번 눌러야 소리를 낼 수 있습니다. 누르지 않아도 빗소리가 나게 하려면 크롬을 다음처럼 실행하세요.

```bash
chrome.exe --autoplay-policy=no-user-gesture-required --kiosk http://localhost:8001
```

## 구성

- `server.js` — 원래 웹사이트에서 글을 모으고 화면에 전달하는 서버
- `public/main.js` — 나무껍질, 나비, 꽃, 빛의 선, 비 (Three.js)
- `public/index.html`, `public/style.css` — 화면 구성과 QR
- `data/words.json` — 지금까지 모인 관객의 글

나비 모습은 `public/main.js` 맨 위의 `BUTTERFLY_STYLE`로 바꿀 수 있습니다 (`'lines'` 빛나는 선 / `'photo'` 실사 느낌).
