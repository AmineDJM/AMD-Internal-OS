## 🧱 Stack technique

| Couche | Choix |
|---|---|
| **Framework** | Next.js 15.5 (App Router, **React Server Components**, **Server Actions** ; `params`, `searchParams`, `cookies()`, `headers()` **asynchrones**) |
| **Langage** | TypeScript strict · React 19 |
| **Base de données** | PostgreSQL + **Prisma 5.22** |
| **Auth** | **Auth.js / NextAuth v5** (`5.0.0-beta.32` — pas de v5 stable publiée ; Credentials, JWT, bcrypt, `trustHost`) + **sessions révocables en base** |
| **UI** | Tailwind CSS + **design system maison** (style shadcn/ui) · `lucide-react` · **Recharts** |
| **Documents** | Aperçu **embarqué** : `mammoth` (Word), `xlsx`/SheetJS 0.20.3 (Excel — paquet du **CDN officiel SheetJS**, npm n'est plus mis à jour), `jszip` (PowerPoint), iframe (PDF) ; **impression** via iframe same-origin |
| **E-mail** | `imapflow` (IMAP) · `nodemailer` (SMTP) · `mailparser` (MIME) |
| **IA** | Claude (Anthropic) pour le texte/agent · Whisper (OpenAI) pour la transcription vocale |
| **Édition Office** | OnlyOffice Document Server auto-hébergé (JWT HS256) |
| **Son** | **Web Audio API** — bip de notification généré à la volée (aucun fichier audio), débloqué au 1er geste |
| **QR / billetterie** | `qrcode` (inscription publique + check-in événements) |
| **Déploiement** | **Render** (Web Service + PostgreSQL managé, Blueprint `render.yaml`) |

> Tout secret (clés IA, secrets JWT, mots de passe e-mail) est **strictement côté serveur** — jamais exposé au
> navigateur, jamais committé. La clé maître de chiffrement dérive d'`AUTH_SECRET`.

---

