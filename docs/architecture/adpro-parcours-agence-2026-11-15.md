# Ad & Pro — le parcours agence et la signature en ligne des BC (15/11/2026)

> Décision de la Direction, validée sur l'artefact « Circuit Événement – Agences – Paiement » (questions Q1 à Q17,
> réponses du 15/11/2026). Complète le circuit du 27/10/2026 (`adpro-circuit-2026-10-27.md`), qui reste valable pour la
> prévalidation : délégué → National Sales → Directeur des opérations → Direction Marketing.

## Le chemin d'un poste « par une agence »

| # | Étape | Qui | Geste (action serveur) | Écran |
|---|---|---|---|---|
| 1 | Prospection demandée (cahier des charges, assistante) | Direction Marketing | `demanderProspection` | carte du poste |
| 2 | Devis déposés, lignes vérifiées, transmis | Assistante de direction | `ajouterDevisPoste` (existant), `transmettreDevisAgences` | `/agences/<poste>` |
| 3 | Agence choisie : montant = devis retenu, budget ; autres devis « non retenus » ; BC né en brouillon | Direction Marketing | `choisirAgencePoste` | carte du poste (comparatif) |
| 4 | BC finalisé dans le composeur puis soumis | Assistante | composeur existant, `soumettreBcMarketing` | `/agences/<poste>` |
| 5 | BC validé, numéroté, **signé et cacheté en ligne** | Direction Marketing | `validerSignerBcMarketing` (`signerBcMarketing` en reprise) | carte du poste |
| 6 | Visa du centre Ad & Pro au-dessus du seuil BC | DG / Super Admin | `approveAdProItemOrder` (existant) | carte, `/centre-ad-pro` |
| 7 | BC **signé et cacheté en ligne** (ou copie signée déposée) | Finances | `signerBonDeCommandeEnLigne` (ou `signerBonDeCommande`) | `/bons-de-commande` |
| 8 | BC envoyé à l'agence | Direction Marketing | `marquerBcEnvoye` | carte du poste |
| 9 | BAT transmis → conforme / non conforme (si requis) | Direction Marketing → Information médicale | `envoyerBatConformite`, `deciderConformitePoste` | carte, `/information-medicale/conformite` |
| 10 | PV de réception (réserve possible, photos) | Direction Marketing ou le demandeur sur place | `signerReceptionPoste` | carte du poste |
| 11 | Facture déposée, paiement demandé | Direction Marketing | `deposerFacturePoste`, `demanderPaiementPoste` (existants, gardés par `refusAvantReception`) | carte du poste |
| 12 | Centre de paiement, puis paiement | DG / Super Admin, puis Finances | existant | `/centre-de-paiement`, Finances |
| 13 | Information médicale → ANPP | Information médicale | **à concevoir** (Q16) | — |

État et prochain geste : `src/modules/ad-pro/domaine/parcours-agence.ts` (`etapeAgence`, `friseAgence`, `pasAgence`, testés).
Écran : `ecrans/postes/parcours-agence.tsx`, monté par `PosteCarte` quand `AdProItem.voie = AGENCE`.

## Les décisions (Q1 à Q17)

- **Q1** Le chemin vaut pour tout poste marqué « par une agence », quelle que soit la nature. `AdProItem.voie` : `AGENCE`,
  `DIRECT` (sans BC : pro forma ou facture), `null` (règle d'avant, postes en cours inchangés). `sansBonDeCommande()`
  remplace la lecture par nature seule (`VERSEMENT_SANS_BC`).
- **Q2** Une demande d'Ibrahim (National Sales) part directement au Directeur des opérations : déjà la règle (`parcoursAdPro`).
- **Q3** Seule la Direction Marketing accepte un poste ; un poste ajouté par un autre est une proposition (brouillon), et sur
  la voie agence elle seule lance la prospection.
- **Q4** Un BC par agence retenue (le BC naît du devis retenu).
- **Q5** Trois devis conseillés, signalés quand il y en a moins, sans blocage. Agences = `CompanyContact` du devis.
- **Q6** Un seul passage chez le DG : pour un poste agence, le **visa du BC** au centre Ad & Pro (seuil BC) ; la porte sur le
  total n'y est qu'un signal (`refusPorteDgDuPoste`). Un poste payé directement n'a pas de visa de BC : la porte sur le total
  reste son passage.
- **Q7** L'assistante modifie tout le BC ; l'écart avec le devis se voit à la validation.
- **Q8** Signature en ligne : image de signature + cachet (chiffrés), mot de passe + code TOTP, PDF scellé (SHA-256, QR vers
  `/verifier-bc/<jeton>`). La copie imprimée-signée-déposée reste possible pour les Finances.
- **Q9** Le BC signé part à l'agence depuis la carte (téléchargement + « c'est envoyé », tracé).
- **Q10** Conformité proposée selon la nature (`conformiteParDefaut` : imprimerie, stand, symposium, matériel promo,
  prestation) ; la Direction Marketing coche ou décoche.
- **Q11** La conformité porte sur le BAT, avant impression.
- **Q12** Centre de paiement : DG + Super Admin (+ le rôle Direction, inchangé). Le rôle secondaire compte désormais
  (`sitsOnPaymentCentre`), l'écran des sièges liste le DG parmi les sièges par rôle.
- **Q13** Acomptes : non développés dans ce lot (la facture reste ≤ BC) — à reprendre si une agence l'exige.
- **Q14** La réception se signe par la Direction Marketing ou le demandeur présent sur place.
- **Q15** Yacine = rôle `OPERATIONS_DIRECTOR`.
- **Q16** La déclaration d'information médicale reste à la prévalidation ; le dossier ANPP après paiement est à concevoir.
- **Q17** Le délégué médical suit ses postes sans les détails (`SuiviSimple` : étapes et étape en cours, ni montants ni pièces).

Sponsoring : le **bloc principal** (`AdProItem.principal`, le prix proposé par le médecin et le délégué) et les autres blocs
(transport, dîner…) sont des postes de la même demande ; chacun choisit sa voie (le principal : direct ou par BC, au cas par cas).

## La signature en ligne

`src/lib/signature-en-ligne/` : `totp.ts` (RFC 6238, vecteurs officiels testés), `second-facteur.ts` (secret chiffré
AES-256-GCM sous une clé dérivée du coffre, anti-rejeu `dernierPas`, échecs comptés comme la connexion), `visuels.ts`
(signature et cachet, fond rendu transparent, stockés chiffrés), `placement.ts` (pur, testé), `incruster.ts` (mupdf : images
sous « Signature et cachet », sceau QR au pied, états graphiques refermés), `signer-bc.ts` (une signature par qualité,
`SignatureBC`), `etat.ts`, `partage.ts` (pur, navigateur). Page « Ma signature » : `/mon-espace/signature`. Refusé en
« Vue exacte ».

## Files et menus

- `/agences` « Prospection d'agences » : assistante (ses postes), Direction Marketing et Super Admin (tous).
- `/agences/<poste>` : le poste seul, pour l'assistante (accès par `AdProExecutionPoste.assistanteId`, `estAssistanteDuPoste`).
- `/information-medicale/conformite` « Contrôles de conformité ».
- « Aujourd'hui » (centre d'actions) : `tachesAgence`.

## Données

Migration `20270242000000_parcours_agence` : `AdProItem.principal|voie|conformiteRequise`, `AdProExecutionPoste`,
`SignatureBC`, `SignatureVisuelle`, `SecondFacteur`.
