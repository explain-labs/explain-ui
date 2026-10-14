**What the paper did (§3.1.1).** The baseline state of the model was compared with published haemodynamic data for healthy term newborns: cardiac MRI volumes and outputs from Jhaveri et al. [17] and Groves et al. [18], superior vena cava flow from Kluckow & Evans [19], and blood pressure from van Zadelhoff et al. [20]. The reported simulation is a **3.3 kg neonate at 24 h**, sampled at end-expiration.

**What this run does.** It loads the term neonate, scales it to 3.3 kg, sets the heart-rate set-point of the autonomic controller to the paper's 118 min⁻¹, settles for two minutes of model time and then averages the beat-to-beat read-outs over 30 s. Chamber volumes are reported per kilogram, as in Jhaveri et al.

Press **Run experiment** and compare the last column with the paper and the literature. Green means within the literature's standard deviation (or the paper's own margin where the source gives none).
