Core physics parameters (elastance, unstressed volume, resistance, …) each have a **factor**, which multiplies the baseline value:

- **1.0** is the baseline, **2.0** doubles it and **0.5** halves it.
- Factors stay in place until you change them back, and they stack with weight scaling and other interventions.

To make a relative change such as "make the LV twice as stiff", use the factor rather than the base value. Setting the factor back to 1.0 undoes the change exactly.
