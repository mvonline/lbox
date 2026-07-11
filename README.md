# Lighner Box

A static three-language Leitner box vocabulary trainer that runs on GitHub Pages.

## Features

- Three-language vocabulary cards
- Shared vocabulary stored separately from learner profiles
- Admin CSV import from file or pasted text
- Categories such as Fashion, Economy, and IT
- Review scheduling with five Leitner boxes
- Unique profile name for moving between devices
- Target language selection per learner
- Daily, weekly, all-due, new-word, and manual review modes
- Manual review filters for all, passed, hard, easy, and not passed words
- XP, levels, streaks, daily quests, weekly rhythm, mastery progress, and badges
- Local storage fallback
- Optional Firebase Anonymous Auth and Firestore cloud sync
- GitHub Actions deployment to Pages

## CSV format

Use three columns and choose the category in Admin:

```csv
English,Swedish,Persian
hello,hej,سلام
book,bok,کتاب
```

The first row can be headers or data. Exported CSV includes a first `Category` column and can be imported again.

## Learning Flow

1. Create a profile with a unique name.
2. Choose the language you want to learn. That language becomes the main word shown on each card.
3. Reveal the answer and grade yourself:
   - Not passed: returns to Box 1.
   - Hard: moves down one box.
   - Passed: moves up one box.
   - Easy: moves up two boxes.
4. Use Daily goal for structure, Weekly review for upcoming cards, All due for backlog, New words for unseen vocabulary, and Manual review to revisit words by last result.

## Cloud sync

GitHub Pages cannot store shared user data by itself. To sync profiles across devices without passwords:

1. Create a Firebase project.
2. Enable Anonymous Authentication.
3. Create a Firestore database.
4. Add your Firebase web app config to `firebaseConfig` in `app.js`.
5. Publish to GitHub Pages.

Firestore stores shared vocabulary and learner progress separately:

```text
app/main
  languages
  categories
  vocab

profiles/{normalizedName}
  profile
  progress
  reviews
  stats
```

Profiles are saved by normalized unique profile name.

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
