# Lighner Box

A static three-language Leitner box vocabulary trainer that runs on GitHub Pages.

## Features

- Three-language vocabulary cards
- CSV import from file or pasted text
- Browser-side merge into one vocabulary list
- Review scheduling with five Leitner boxes
- Profile code for moving between devices
- Local storage fallback
- Optional Firebase Anonymous Auth and Firestore cloud sync
- GitHub Actions deployment to Pages

## CSV format

Use three columns:

```csv
English,Swedish,Persian
hello,hej,سلام
book,bok,کتاب
```

The first row can be headers or data.

## Cloud sync

GitHub Pages cannot store shared user data by itself. To sync profiles across devices without passwords:

1. Create a Firebase project.
2. Enable Anonymous Authentication.
3. Create a Firestore database.
4. Add your Firebase web app config to `firebaseConfig` in `app.js`.
5. Publish to GitHub Pages.

Profiles are saved in the `profiles` collection by profile code.

## Run with Docker

Build and serve the app locally with nginx:

```sh
docker compose up --build
```

Then open http://localhost:8080. If port 8080 is taken, pick another one:

```sh
LBOX_PORT=8081 docker compose up --build
```

Or without compose:

```sh
docker build -t lbox .
docker run --rm -p 8080:80 lbox
```

## Deploy

Push this repository to GitHub with the default branch named `main`, then enable GitHub Pages with `GitHub Actions` as the source. The included workflow deploys the static files.
