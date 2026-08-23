# Family Wallet

A mobile-first household finance PWA for recording income, expenses, transfers and shared account activity in Malaysian Ringgit (RM).

## What it does

- Google sign-in through your own Firebase project
- Personal and shared household ledgers
- Gmail invitation flow for family members
- Income, expense and atomic account-to-account transfers
- One-tap icon categories with an Other/custom option
- Monthly summaries, account detail and newest-first activity
- Responsive account-detail pagination (6 per phone page, 10 on larger screens)
- Account photos compressed in the browser
- A shared item cabinet for deposits, installments, receipts, balances and manual archive
- Item payments can atomically create a linked shopping expense or stay independent from the ledger
- Separate, on-demand compressed item covers and receipt documents; image bytes never enter realtime item/payment listeners
- Installable Web/iPhone icon assets without the source canvas border
- Offline PWA shell, local Firestore cache and truthful cached/pending/offline/recovering sync states
- Recycle bin, restore, reconciliation and metadata-only JSON export from the low-frequency settings menu
- Responsive phone and desktop layouts

## Privacy model

The public repository contains application source and synthetic test fixtures only. It does not contain real ledger data, user emails, photos, database exports, access tokens, service accounts or private keys.

A deployed copy connects only to the Firebase project configured by that deployer. Forking or cloning this repository does not use the original deployer's Firebase quota. Visitors to a live deployment would use that deployment's Firebase project, so production access is intentionally restricted:

- only an owner pre-approved in the server-side `access/{uid}` collection can initialize a ledger;
- additional members can join only through an invitation sent by that owner;
- strangers cannot create a Firestore profile, household or owner authorization;
- Firebase App Check and Firestore Security Rules are required before production use.

The Firebase Web API key is a public project identifier, not an administrator credential. Authorization is enforced by Firebase Authentication, App Check and Firestore Security Rules. Never commit a service-account file, private key, OAuth secret, access token or database export.

## Deploy your own copy

### 1. Create Firebase services

Create a Firebase Spark project, then:

1. Add a Web App.
2. Enable Authentication → Google.
3. Create a Cloud Firestore database.
4. Register the final web domain under Authentication → Authorized domains.
5. Register the Web App in Firebase App Check with reCAPTCHA Enterprise and keep enforcement off until the first verified login.
6. Deploy `firestore.rules` with the Firebase CLI.

Data Connect and Firebase Storage are not required. This project stays compatible with Spark: item covers are compressed to at most about 80 KB and receipts to about 180 KB, then stored in separate authorized Firestore media documents with the image field excluded from indexing. Item and payment list listeners contain metadata only. Account photos remain compressed inside the authorized account document for backward compatibility.

### 2. Configure GitHub Actions

Create these GitHub Actions repository secrets:

- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`
- `FIREBASE_APP_CHECK_SITE_KEY`

The workflow injects them into the generated `dist/firebase-config.js`. Production values stay out of the Git source history, although the deployed Web configuration remains visible to browsers by design.

### 3. Approve the first owner

1. Open the deployed App and sign in with the intended owner Google account.
2. The App displays an authorization UID and refuses all Firestore writes.
3. In Firestore Console, create `access/{UID}` with:

```json
{
  "role": "owner",
  "active": true
}
```

4. Reload the App. The approved owner can initialize the personal ledger.
5. Invite the family member from inside the App. The invited Gmail account may join only that shared household.
6. Verify both accounts can write, receive realtime updates, recover after foregrounding and reject cross-household access before enabling App Check enforcement.

Do not publish a live link before this owner gate, App Check and the final Rules tests have been verified.

### 4. Publish GitHub Pages

The Pages workflow runs:

1. application tests;
2. Firebase Auth/Firestore Emulator Rules tests;
3. public credential and personal-email audit;
4. a runtime-only build;
5. GitHub Pages deployment.

Tests, emulator pages, logs and local project records are not included in the Pages artifact.

## Local development

```bash
npm ci
npm test
npm run test:rules:emulator
npm run audit:public
npm run build
npm run serve
```

Use `?local=1` for the device-only demonstration mode. It does not connect to Firebase.

## Item payment and export boundaries

- Linked item payments require an online Firestore transaction. The payment, item balance and deterministic shopping expense succeed or fail together.
- Independent item payments update only item progress and do not change an account balance or monthly spending.
- Ordinary income, expense and transfer entry keeps Firestore's offline queue behavior.
- Payment corrections use void and restore records instead of overwriting history.
- The settings export contains the selected ledger, item metadata and payment metadata under `schemaVersion: 2`. It excludes image Data URLs, authentication profiles, access records, invitations, membership records and Firebase configuration.

## Quota ownership

- Visiting a deployed site uses that site's Firebase project only after authenticated, authorized operations occur.
- Forking the repository and adding another Firebase configuration uses the fork owner's Firebase project and quota.
- Staying on Firebase Spark prevents automatic billing; exceeding free quota causes service limits rather than an automatic charge.

Official references:

- Firebase API keys: https://firebase.google.com/docs/projects/api-keys
- Firestore quotas: https://firebase.google.com/docs/firestore/quotas
- Firebase App Check: https://firebase.google.com/docs/app-check
- GitHub Pages: https://docs.github.com/en/pages

## Security

See [SECURITY.md](SECURITY.md). Production publication must pass the automated public audit and real two-account acceptance flow.
