## 🔐 Sécurité & contrôle d'accès (RBAC)

Le contrôle d'accès est **dynamique, à deux couches, toujours appliqué côté serveur** :

1. **Permissions module × action** — matrice par rôle (`PERMISSIONS` dans `src/lib/rbac.ts`, **exhaustive** : ajouter
   un rôle force une entrée), affinée par des **overrides par utilisateur** (`UserAccess`) gérés depuis l'admin.
2. **Row-level scoping** — les helpers `scope*()` renvoient des **fragments Prisma `where`** : les lignes non
   autorisées **ne sont jamais envoyées au client** (filtrées en base, pas seulement masquées à l'écran).

```
getAccess(user)  →  accès EFFECTIF (caché par requête)
   ├── userCan(user, module, action)      → la page/action est-elle permise ?
   ├── hasGlobalView(role)                → Super Admin / Direction voient tout
   ├── defaultScope(role, module)         → ALL ou ASSIGNED ?
   └── scopeRegulatory / scopeSales / scopeAdminRequests / scopeMedicalInfo / … → where Prisma
canAccessEntity(user, entityType, id, action)   → contrôle d'accès POLYMORPHE par ligne
```

> **Atterrissage sûr** : si une page est refusée, l'utilisateur est renvoyé vers la **première destination
> qu'il peut réellement voir** — pas de boucle `ERR_TOO_MANY_REDIRECTS`. S'il n'a accès à rien, une page
> `/no-access` claire l'invite à contacter l'admin.

> **Exemple** : la Direction des opérations voit tout (`hasGlobalView`) ; une **assistante Regulatory** ne voit
> que les DCI qui lui sont assignées ; un **délégué** ne voit que ses propres demandes et tournées ; la **Direction
> Marketing**, qui tranche, voit toutes les demandes Ad & Pro ; le **National Sales**, doté d'une **portée ALL** sur
> les circuits Ad & Pro (hors matériel promotionnel : ses dossiers), voit toutes les demandes à approuver.

**Gardes serveur** : `requireModule(module, action)` protège la plupart des pages (d'autres lisent `requireUser()` puis une règle d'organisation — le centre de paiement, par exemple), `requireUser()` chaque server action.
Toute action sensible est **ré-autorisée côté serveur** et **journalisée**.

**Autres mesures** :
- 🔒 **Chiffrement AES-256-GCM** des blobs Drive (adressage par contenu SHA-256) et des mots de passe e-mail, clé
  maître dérivée d'`AUTH_SECRET`.
- 🪪 **Sessions révocables** en base ; 👁️ **Vue exacte** (impersonation) honorée **uniquement** si la session
  réelle est Super Admin, et **en lecture seule** : toute écriture part au nom du Super Admin réel.
- 🧾 **Journal d'audit** complet (qui / quoi / ancienne → nouvelle valeur / date / module), y compris la
  **suppression traçable** des demandes (motif obligatoire) et la **modération** (édition/suppression de
  commentaires, pièces jointes et messages par l'admin / responsable / auteur).
- 🚧 **Anti-bruteforce** : verrouillage temporaire progressif après échecs (`LoginAttempt`), anti-énumération,
  message générique, audit. Connexion **insensible à la casse** de l'e-mail.
- 🛡️ **En-têtes de sécurité** : CSP (`frame-ancestors`, `object-src 'none'`, `base-uri`, `form-action`), **HSTS**
  (2 ans, preload), `X-Frame-Options`, `COOP`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- 🤖 **Centre de contrôle IA** (Super Admin) : interrupteur général + activation par fonction + journal d'usage.
- 🔢 Identifiants **cuid** non séquentiels ; upload contrôlé (**exécutables bloqués** + **taille configurable**,
  tous autres types acceptés) ; download protégé par vérification d'accès.

**Parcours de première connexion** : un nouveau compte doit **définir son mot de passe**, puis suit un
**onboarding guidé** (`/onboarding`) — coordonnées, **connexion e-mail** et **visite des onglets accessibles**.
Deux écarts connus : la visite lit le menu par les seuls droits de **module**, sans ses gardes propres — l'Assistant IA,
les Missions d'Adam, Mon Équipe, le Pipeline ou l'Analyse CTD peuvent y être proposés à qui n'y entre pas ; et l'étape
« connexion e-mail » propose encore la boîte **Infomaniak** de l'ancien Courrier (retiré). Le Super Admin peut
**redéclencher le setup**. Le drapeau `mustOnboard` est
**lu à chaud en base** : la fin du parcours prend effet **immédiatement, sans reconnexion**.

---

### Assistant IA — l'assistant d'une personne (S1, décision 0048)

- **Vue exacte** : l'assistant (texte, voix, gestes, notes) est **fermé** — le corps d'une action y porte le Super Admin
  réel. Garde : `enVueExacteIa` (`modules/assistant-ia/domaine/acces-regles.ts`) dans `beta/actions.ts` et `jouerTour`.
- **Par défaut** chacun ne voit que ses propres données (fiche **liée** au compte : `Employee.userId`, jamais devinée).
- **Données sensibles d'autrui** (paie, dossier RH) : droit applicatif RH dans la société de la fiche, **avenant** de
  délégation daté sur une entité (`AvenantContrat`), ou **droit daté** nominatif de la console (`AssistantIaDroitDate`) —
  jamais un réglage de rôle (`domaine/perimetres.ts`, `perimetreCouvrant`). Révélation auditée avec origine et motif.
- **Profil** : `infra/profil-personne.ts` — la section « INTERLOCUTEUR » de chaque tour. Console : `/admin/ai/acces`,
  carte « Ce que son assistant voit ».

