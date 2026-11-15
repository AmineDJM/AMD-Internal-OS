## Ad & Pro — le parcours agence et la signature en ligne des bons de commande (15/11/2026)

Un poste Ad & Pro (stand, salle, imprimerie, bloc principal d'un sponsoring…) se paie **par une agence** ou **directement**.
Par une agence, il suit un seul chemin, le même pour toutes les natures :

1. **Direction Marketing** — « Demander la prospection d'agences » (cahier des charges, assistante choisie).
2. **Assistante de direction** — dépose les devis des agences (3 conseillés), vérifie leurs lignes, « Transmettre ».
   Sa file : **Prospection d'agences** (`/agences`) ; elle ne voit que les postes qu'on lui confie.
3. **Direction Marketing** — compare les devis et « Retenir cette agence » : le montant accordé est celui du devis, avec le
   budget ; les autres devis sont « non retenus » ; le BC naît en brouillon chez l'assistante.
4. **Assistante** — finalise le BC dans la plateforme (composeur) et le soumet.
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

Référence technique : `docs/architecture/adpro-parcours-agence-2026-11-15.md`.
