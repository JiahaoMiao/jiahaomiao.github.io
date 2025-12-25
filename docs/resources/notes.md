# Physics Notes

Here are some derivations and notes from my coursework.

## Quantum Field Theory

!!! note "Definition: The Lagrangian Density"
    For a scalar field $\phi$, the Lagrangian density is given by:
    
    $$
    \mathcal{L} = \frac{1}{2} (\partial_\mu \phi)(\partial^\mu \phi) - \frac{1}{2} m^2 \phi^2 - \frac{\lambda}{4!} \phi^4
    $$
    
    This describes a massive scalar field with a quartic interaction.

!!! tip "Tip: Metric Signature"
    In these notes, I strictly use the **mostly minus** metric signature $(+,-,-,-)$.

## General Relativity

!!! warning "Important"
    Remember that covariant derivatives $\nabla_\mu$ do **not** commute when acting on vectors in a curved spacetime. This gives rise to the Riemann curvature tensor:
    
    $$
    [\nabla_\mu, \nabla_\nu] V^\rho = R^\rho_{\sigma\mu\nu} V^\sigma
    $$