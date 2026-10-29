"""Database models and session factory (PostgreSQL via asyncpg)."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    SmallInteger,
    String,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Player(Base):
    __tablename__ = "players"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # HMAC(pepper, recovery key). The key itself is never stored.
    key_hash: Mapped[bytes] = mapped_column(LargeBinary(32), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_active: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class GameProgress(Base):
    __tablename__ = "game_progress"
    __table_args__ = (CheckConstraint("unlocked_level BETWEEN 1 AND 10000", name="unlocked_range"),)

    player_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("players.id", ondelete="CASCADE"), primary_key=True
    )
    game_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    unlocked_level: Mapped[int] = mapped_column(Integer, nullable=False, default=1)


class LevelResult(Base):
    __tablename__ = "level_results"
    __table_args__ = (CheckConstraint("stars BETWEEN 1 AND 3", name="stars_range"),)

    player_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("players.id", ondelete="CASCADE"), primary_key=True
    )
    game_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    level: Mapped[int] = mapped_column(Integer, primary_key=True)
    stars: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    best_moves: Mapped[int | None] = mapped_column(Integer)
    completed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class HintUsage(Base):
    __tablename__ = "hint_usage"
    __table_args__ = (CheckConstraint("used >= 0", name="used_non_negative"),)

    player_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("players.id", ondelete="CASCADE"), primary_key=True
    )
    game_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    day_utc: Mapped[date] = mapped_column(Date, primary_key=True)
    used: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)


def make_engine(url: str, pool_size: int, max_overflow: int) -> AsyncEngine:
    return create_async_engine(
        url, pool_size=pool_size, max_overflow=max_overflow, pool_pre_ping=True
    )


def make_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def session_scope(maker: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    async with maker() as session:
        yield session
