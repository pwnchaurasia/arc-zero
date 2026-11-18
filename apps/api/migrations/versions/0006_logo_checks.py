"""LogoQuest practice log: one row per "Check my code", so a parent can follow progress.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "logo_checks",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("day", sa.Date(), server_default=sa.text("CURRENT_DATE"), nullable=False),
        # Saved players by id (so a parent can look them up by name); guests by `who`.
        sa.Column(
            "player_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("players.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("who", sa.String(16), nullable=False),
        sa.Column("attempt", sa.String(64), nullable=False),
        sa.Column("level", sa.SmallInteger(), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("passed", sa.Boolean(), nullable=False),
        sa.Column("accuracy", sa.SmallInteger(), nullable=False),
        sa.Column("blocks", sa.SmallInteger(), nullable=False),
        sa.Column("par", sa.SmallInteger(), nullable=False),
        sa.Column("stars", sa.SmallInteger(), nullable=True),
        # Server clock, from opening the level to this check.
        sa.Column("seconds", sa.Integer(), nullable=False),
        # Reported by the app: time the screen was visible, Run presses, chip taps.
        sa.Column("active_seconds", sa.Integer(), nullable=False),
        sa.Column("runs", sa.SmallInteger(), nullable=False),
        sa.Column("taps", sa.SmallInteger(), nullable=False),
        sa.Column("hints", sa.SmallInteger(), nullable=False),
        sa.Column("program", sa.Text(), nullable=False),
        # Comma-separated reasons to look closer, e.g. "fast,no_runs".
        sa.Column("flags", sa.String(64), nullable=False, server_default=""),
    )
    op.create_index("ix_logo_checks_player_day", "logo_checks", ["player_id", "day"])


def downgrade() -> None:
    op.drop_index("ix_logo_checks_player_day", table_name="logo_checks")
    op.drop_table("logo_checks")
