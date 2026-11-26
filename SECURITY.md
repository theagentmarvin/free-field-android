# Security Policy

Please report security vulnerabilities privately. Do not open a public issue.

Use GitHub's private vulnerability reporting ("Security" tab, "Report a vulnerability") on this repository. If that is unavailable, contact the maintainers directly through the contact method listed on the repository owner's profile.

Include a description, reproduction steps, affected version or commit, and impact. We aim to acknowledge reports within 5 business days and will coordinate a fix and disclosure timeline with you.

Scope notes: the app signs in against, and stores data in, the Firebase project of the company that builds it; access control is enforced by that project's Firestore and Storage rules (maintained in the FreeField web repository). Firebase web client configuration values are public by design. Signing keys and `apps/mobile/.env.production` must never be committed; if you find one in a repository, report it so it can be rotated.
