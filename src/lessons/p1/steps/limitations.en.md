The paper's results were obtained in January 2026 with an earlier implementation of the same model. The experiments on this page were rebuilt from the method and the levers the paper describes, on the engine that runs in your browser, and tuned only through those levers. The table rows coloured amber show where the two still differ:

- **Pulmonary hypertension, severe states.** The paper's columns show systemic pressure and output falling with the pulmonary hypertension (ABP 50/24, Qs 132–143 ml/kg/min). This engine keeps the systemic side up with the same pulmonary levers, so the transpulmonary gradient and pulmonary pressures are matched but the systemic pressures are 10–14 mmHg above the paper's. The paper names no lever for that fall, so it is reported here rather than tuned in by other means.
- **Left-to-right duct.** Left-ventricular output stays below the paper's 261 ml/kg/min at the paper's LVO/RVO ratio; a larger shunt raises both.
- **Restrictive Doppler.** The pattern is reproduced, the jet velocity of a 1 mm duct is not.

Everything on this page is reproducible from the command line: the engine's `scripts/probe_p1.mjs` runs the same experiment file (`papers/p1/experiments.json`) headlessly and prints the same tables. The source code is at github.com/explain-labs/explain-engine; the engine release that contains these experiments is named in the paper's data-availability statement.

You can keep exploring: the duct and foramen are under *Interventions*, and *Restart* returns to the term baseline.
