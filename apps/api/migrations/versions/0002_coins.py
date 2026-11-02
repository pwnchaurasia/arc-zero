"""Coins: one wallet per player, a ledger of every change, assist-free streaks.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-02
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "game_progress",
        sa.Column("streak", sa.SmallInteger(), nullable=False, server_default="0"),
    )
    op.create_table(
        "wallets",
        sa.Column(
            "player_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("players.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("balance", sa.Integer(), nullable=False),
        sa.CheckConstraint("balance >= 0", name="balance_non_negative"),
    )
    op.create_table(
        "coin_ledger",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "player_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("players.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("delta", sa.Integer(), nullable=False),
        sa.Column("balance_after", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(16), nullable=False),
        sa.Column("game_id", sa.String(32), nullable=True),
        sa.Column("level", sa.Integer(), nullable=True),
        sa.Column("detail", sa.String(64), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_coin_ledger_player_id", "coin_ledger", ["player_id"])
    op.create_index(
        "coin_ledger_one_clear",
        "coin_ledger",
        ["player_id", "game_id", "level"],
        unique=True,
        postgresql_where=sa.text("reason = 'clear'"),
    )


def downgrade() -> None:
    op.drop_index("coin_ledger_one_clear", table_name="coin_ledger")
    op.drop_index("ix_coin_ledger_player_id", table_name="coin_ledger")
    op.drop_table("coin_ledger")
    op.drop_table("wallets")
    op.drop_column("game_progress", "streak")
