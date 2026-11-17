# Open legal and regulatory questions for counsel

Prepared by engineering, not legal advice. Each item notes why it matters for the design.

## Money transmission and licensing
1. Paygent is open-source software that each user runs on their own machine, with their own wallet and provider accounts, and no Paygent entity ever holds or moves funds. Does publishing it create any money-transmitter exposure for the maintainers under FinCEN's 2019 CVC guidance (the "software provider" exception) or under state law, including New York's BitLicense?
2. The SpendPermissionManager `spend` call moves USDC from the user's wallet to a spender address that the user's own install controls. Does that brief hop change anything for the user (e.g., unhosted-wallet treatment) or for maintainers?
3. If a hobbyist runs Paygent for a household member or a friend, they would be moving someone else's money. Should the licence or docs forbid this, and how?

## Provider terms
4. Privacy.com's General Terms prohibit "automated purchasing software programs" and say cards are "not for consumer use" and for "business purposes", yet Privacy.com publishes an MCP server for AI agents. Can a consumer lawfully use Paygent with Privacy.com? What written confirmation would be enough?
5. Stripe Issuing requires business-purpose spend. Is a sole proprietor running personal purchases through it in breach?
6. Laso Finance issues prepaid cards for USDC without identity checks on the order endpoints. Is integrating it consistent with prepaid-access rules (31 CFR 1022, the prepaid access rule) and with the "Don't design around the rules" requirement? Should Paygent refuse to support no-KYC issuers?
7. Does the card networks' tokenization or agent rules (Visa Intelligent Commerce, Mastercard Agent Pay) restrict passing a PAN to an automated agent, even inside the user's own browser?

## Fiat funding paths (added with the fiat-funding scope change)
15. `fiat_direct`: Paygent creates cards through the owner's own issuer account, funded by the owner's bank or debit card. Does software that automates card creation and checkout for the account holder raise any issue beyond the issuer's terms (e.g., the issuer's program manager or sponsor bank rules)?
16. Privacy.com markets AI-agent use (agents.privacy.com, a hosted MCP server) while its General Terms (2023-09-06) prohibit "automated purchasing software programs" and its Payment Terms say cards are "not for consumer use" and "for business purposes". Which governs? What written confirmation from Privacy.com would let consumers use Paygent with it, and should Paygent require owners to attest that they have it?
17. On-ramps (Coinbase Onramp, Stripe, MoonPay) are built for businesses integrating them for their customers. Can an individual integrate one only for their own purchases (they are both the "platform" and the "customer")? Does that create any obligations for the individual?
18. Stripe's onramp makes Stripe the merchant of record and handles KYC; Coinbase's guest checkout for US residents was capped at $500/week. Do on-ramp limits or KYC tiers create any issue if Paygent automates top-ups (Paygent v0.1 requires the owner to complete each top-up in the provider's page)?
19. Regulation E for `fiat_direct`: if the card draws on the owner's bank account and an agent makes an unwanted purchase within the owner's policy, is that an "unauthorized electronic fund transfer"? How should the README describe dispute rights?

## Consumer protection and liability
8. Regulation E / Z: when an agent the user configured makes a purchase, is it "authorized" by the user for dispute purposes? How should the docs explain that users may not be able to dispute agent purchases?
9. State-by-state: which states restrict prepaid cards, virtual cards, or crypto-funded payments in ways relevant to individual users (e.g., Hawaii and New York for crypto services, prepaid card fee rules)?
10. Sanctions/OFAC: does an open-source payment tool need any screening feature, or is it the providers' responsibility?

## Licence, disclaimer, and notices
11. Is Apache-2.0's warranty disclaimer and limitation of liability enough, or should the README carry an additional "not a financial service, test mode only, you are responsible for provider terms" notice? Proposed wording is in `README.md` under "Status and disclaimer" and needs review.
12. Trademark: can the README and adapter names use "Visa", "Coinbase", "Lithic", "Privacy.com" descriptively?
13. Should the project publish an "acceptable use" statement (e.g., no use to evade KYC, no use for others' funds), and is that enforceable under an open-source licence (it isn't part of Apache-2.0)?
14. Export controls on the cryptography in the project (EAR 5D002 / publicly available exception): any filing needed for an open-source release?
