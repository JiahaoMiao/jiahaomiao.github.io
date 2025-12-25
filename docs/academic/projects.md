# WIP

Example of what Mkdocs can do:

# Computational Projects

## Monte Carlo Integration

Here is a comparison of how I implemented a simple Monte Carlo integration in both Python and C++.

=== "Python"

    ```python hl_lines="3-7"
    import numpy as np

    def monte_carlo_pi(n_samples):
        x = np.random.rand(n_samples)
        y = np.random.rand(n_samples)
        inside = (x**2 + y**2) <= 1.0
        return 4.0 * np.sum(inside) / n_samples

    print(f"Pi is approx: {monte_carlo_pi(10000)}")
    ```

=== "C++"

    ```cpp
    #include <iostream>
    #include <random>

    int main() {
        int n_samples = 10000;
        int inside = 0;
        // ... (implementation details)
        std::cout << "Pi is approx: " << (4.0 * inside) / n_samples << std::endl;
        return 0;
    }
    ```

=== "Result"

    > Pi is approx: **3.14159...**
    
    The convergence rate scales as $1/\sqrt{N}$.


code annotation

```python
def lagrangian(phi, dphi):
    kinetic = 0.5 * dphi**2 # (1)
    potential = 0.5 * m**2 * phi**2 # (2)
return kinetic - potential
```
1. This is the kinetic term $\partial_\mu \phi \partial^\mu \phi$ \\  
2. This is the mass term

```python
def test_function():
    print("Hello") # (1)
```