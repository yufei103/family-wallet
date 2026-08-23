# Security Policy

## Supported deployment

Family Wallet is a static PWA backed by the deployer's own Firebase Authentication and Cloud Firestore project. A production deployment must use:

- Google Authentication with only the intended deployment domains authorized;
- Firebase App Check with reCAPTCHA Enterprise enforcement enabled after verification;
- the repository's Firestore Security Rules;
- a server-seeded owner authorization under `access/{uid}`;
- invitation-only household membership;
- atomic item/payment/linked-ledger validation with strict household references;
- separate JPEG-only item media documents with cover and receipt size limits;
- a restricted Firebase Web API key where supported.

## Public information

Firebase Web configuration, including the Web API key and App Check site key, is visible to browsers in every web application. These values identify the Firebase project but do not grant administrator access. Do not treat them as substitutes for Security Rules or App Check.

## Information that must never be committed

- service-account JSON files;
- private keys, OAuth client secrets, access or refresh tokens;
- Firebase CLI credentials;
- real user email lists or Firebase UIDs;
- Firestore exports, ledger records, account photos or screenshots containing financial data;
- `.env` files or local runtime metadata.

GitHub Actions secrets are used only to prevent production Web configuration from entering Git history. The generated browser configuration is still public by design.

## Item media and export safety

Item covers and payment receipts are optional. The browser accepts JPG, PNG or WebP input, converts it to a bounded JPEG, and writes it to a separate `itemMedia` document. Security Rules bind every media document to the same household and referenced item/payment; realtime item and payment listeners never download image bytes. The large `dataUrl` field is excluded from Firestore indexing.

The in-app export is metadata-only. It recursively removes account-photo and item-media Data URLs and excludes Firebase configuration, users, access records, invitations and household membership documents.

## Reporting a vulnerability

Do not open a public issue containing credentials or personal financial data. Contact the repository owner privately and include only a minimal reproduction with synthetic data.
