## Ad & Pro — le parcours agence et la signature en ligne des bons de commande (15/11/2026)

Un poste Ad & Pro (stand, salle, imprimerie, bloc principal d'un sponsoring…) se paie **par une agence** ou **directement**.
Par une agence, il suit un seul chemin, le même pour toutes les natures :

1. **Direction Marketing** — publie le poste **sans montant ni budget** et « Demander la prospection d'agences » (cahier des
   charges, assistante choisie). Depuis le 24/11/2026, « Créer les postes depuis un fichier » fait les deux d'un geste : le
   cahier des charges reste dans les pièces de la demande, l'IA propose les postes, chaque poste « par une agence » part en
   prospection chez l'assistante choisie avec son cahier des charges.
2. **Assistante de direction** — dépose les devis des agences (3 conseillés ; plusieurs fichiers d'un coup, une carte lue par
   l'IA par fichier, « Déposer les N devis »), vérifie leurs lignes, « Transmettre ».
   Sa file : **Prospection d'agences** (`/agences`) ; elle ne voit que les postes qu'on lui confie.
3. **Direction Marketing** — compare les devis, valide les lignes et « Retenir cette agence » : le montant accordé est celui du
   devis ; les autres devis sont « non retenus » ; le BC naît en brouillon chez l'assistante. Le budget ne s'y choisit plus.
   - **En parallèle (24/11/2026)** : le BC suit les étapes 4 à 7 sans attendre le budget, et la Direction Marketing
     « Choisir le budget » — c'est lui qui ouvre la déclaration à l'information médicale ; le paiement l'exige aussi.
4. **Assistante** — finalise le BC dans la plateforme (composeur) et le soumet. Quand ni la demande ni la fiche salarié du
   demandeur ne nomment la société qui commande, l'aperçu la fait choisir (« Société qui commande »), une fois pour la demande.
5. **Direction Marketing** — « Valider, signer et cacheter le BC » : mot de passe + code de l'application d'authentification.
6. **DG / Super Admin** — visa du centre Ad & Pro si le BC dépasse le seuil BC.
7. **Finances** — « Signer et cacheter » en ligne sur **Bons de commande** (ou déposer une copie signée, comme avant).
8. **Direction Marketing** — envoie le BC à l'agence ; transmet le **BAT** à l'information médicale si le poste est soumis à la
   conformité ; **Information médicale** — « Conforme » / « Non conforme » (file **Contrôles de conformité**).
9. **Direction Marketing** (ou le demandeur sur place) — **PV de réception** (réserve et photos possibles).
10. **Direction Marketing** — dépose la facture ; **centre de paiement** (DG / Super Admin) ; **Finances** paient.

Chaque carte de poste montre une **frise** (Agences → Choix → Bon de commande → Exécution → Réception → Facture → Paiement),
un seul bouton **« À vous »** pour la personne dont c'est le tour, ou la phrase qui dit **chez qui** en est le poste. Les
mêmes tâches remontent dans **Mon espace › Aujourd'hui**. Le délégué qui a signalé l'événement suit ses postes **sans les
détails** (étapes, étape en cours).

**Signature en ligne.** Chaque signataire prépare une fois, dans **Ma signature** (`/mon-espace/signature`), l'image de sa
signature, celle de son cachet, et le code de son téléphone. Au moment de signer : relire, mot de passe, code. La signature
et le cachet sont incrustés dans le PDF, scellé (empreinte SHA-256) avec un QR code qui ouvre la page publique
`/verifier-bc/<jeton>` : l'agence y vérifie qui a signé, quand, et que son fichier est bien celui-là.

**Sponsoring.** Le **bloc principal** (le prix proposé par le médecin et le délégué) et les autres blocs (transport, dîner…)
sont des postes de la même demande ; chacun choisit sa voie — le principal se paie directement ou par BC, au cas par cas.
Depuis le 24/11/2026, le poste principal **naît à la prévalidation** de la Direction Marketing (plus à la création), en
attente de son accord ; un sponsoring direct à l'association se valide au montant de sa pro forma (« Valider le poste
(montant) »), puis son budget se choisit.

**Déclaration à l'information médicale (24/11/2026).** Elle s'ouvre quand chaque poste est accordé, son devis validé (lignes
validées, agence choisie, BC joint ou devis de voyageur retenu) et son budget choisi. Un poste ajouté après l'ouverture est
accepté et la rejoint une fois prêt (montant mis à jour, pharmacien prévenu « Poste ajouté à une déclaration ») ; une
déclaration déjà validée n'est pas réécrite (le pharmacien est prévenu). Règle : `lib/medical-info/declaration-postes.ts`.

Référence technique : `docs/architecture/adpro-parcours-agence-2026-11-15.md`.
