"""Resource budget shared by the comparison deployment and its regression checks."""

MIB = 1024 * 1024

# The peak-RSS contract in tests permits at most 668 MiB for one comparison.
# Add its required 32 MiB safety margin before budgeting concurrent inputs.
COMPARISON_MEASURED_PEAK_MIB = 668
COMPARISON_PER_INPUT_BUDGET_MIB = 700
COMPARISON_CONTAINER_MEMORY_MIB = 2048
COMPARISON_CONTAINER_RESERVE_MIB = 256
COMPARISON_CANCELLATION_WORK_SECONDS = 5
COMPARISON_EXECUTION_STOP_BOUND_SECONDS = 10
COMPARISON_MAX_CONCURRENT_INPUTS = (
    COMPARISON_CONTAINER_MEMORY_MIB - COMPARISON_CONTAINER_RESERVE_MIB
) // COMPARISON_PER_INPUT_BUDGET_MIB

if COMPARISON_MAX_CONCURRENT_INPUTS < 1:
    raise RuntimeError("comparison container cannot safely run one input")
