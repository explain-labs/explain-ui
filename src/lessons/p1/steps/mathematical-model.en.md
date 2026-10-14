Section 2.2 of the paper gives the equations. In short:

- **Heart chambers** are *time-varying elastances* (Beneken [12], Suga [14]). The atria are activated by a half-sinusoid over atrial systole (Eq. 1) and the ventricles by a delayed, skewed half-sinusoid (Eq. 2) whose duration follows Bazett's formula (Eq. 3). Each chamber interpolates between an end-diastolic and a maximum-systolic pressure–volume relation (Eq. 8).
- **Fluid-circuit elements** (Table 1): a *resistor* with linear and non-linear terms and separate forward and reverse resistances (Eq. 4), a *valve* that passes forward flow only (Eq. 5), a *capacitance* whose pressure follows the volume above its unstressed volume (Eq. 6), and a *container* that sums the volumes it encloses and transmits its recoil pressure (Eq. 7).
- **Control of circulation**: an afferent activation function centred on the set-point of mean arterial pressure with minimum and maximum activation (Eq. 9, Fig. 4), low-pass filtered with a receptor time constant, scaled into the sympatho-vagal balance (Eq. 10), which modulates every effector relative to its reference value (Eq. 11).
- **Ductal Doppler** (Eq. 12): the instantaneous ductal flow divided by the cross-sectional area of the duct gives a velocity trace comparable with Doppler recordings.

The source code implementing each equation is cited in the paper by file (`Heart.js`, `Resistor.js`, `Capacitance.js`, `Container.js`, `TimeVaryingElastance.js`, `Ans.js`, `Pda.js`) and is openly available.
